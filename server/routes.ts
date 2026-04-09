import type { Express } from "express";
import { createServer, type Server } from "http";
import { searchRequestSchema, type LiteratureResult } from "@shared/schema";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const OPENALEX_BASE = "https://api.openalex.org";
const POLITE_EMAIL = "lit-search-app@example.com";

// Strip HTML tags from text
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

// Reconstruct abstract from inverted index
function reconstructAbstract(invertedIndex: Record<string, number[]> | null): string {
  if (!invertedIndex) return "";
  const wordPositions: [string, number][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      wordPositions.push([word, pos]);
    }
  }
  wordPositions.sort((a, b) => a[1] - b[1]);
  return wordPositions.map(([word]) => word).join(" ").slice(0, 500);
}

// Fetch source IF (2yr_mean_citedness) in batch
async function fetchSourceIFs(sourceIds: string[]): Promise<Map<string, number>> {
  const ifMap = new Map<string, number>();
  if (sourceIds.length === 0) return ifMap;

  // OpenAlex filter supports OR with "|" for multiple IDs
  // Process in chunks of 50
  const chunkSize = 50;
  for (let i = 0; i < sourceIds.length; i += chunkSize) {
    const chunk = sourceIds.slice(i, i + chunkSize);
    const idsFilter = chunk.map(id => id.replace("https://openalex.org/", "")).join("|");
    const url = `${OPENALEX_BASE}/sources?filter=openalex:${idsFilter}&per_page=50&select=id,summary_stats`;
    
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any;
      for (const source of data.results || []) {
        const meanCitedness = source.summary_stats?.["2yr_mean_citedness"] ?? 0;
        ifMap.set(source.id, meanCitedness);
      }
    } catch (e) {
      console.error("Error fetching source IFs:", e);
    }
  }
  return ifMap;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/search", async (req, res) => {
    try {
      const parsed = searchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      const { query, minIF, yearsBack, maxResults } = parsed.data;
      const now = new Date();
      const fromYear = now.getFullYear() - yearsBack;
      const fromDate = `${fromYear}-01-01`;

      // We need to fetch more works than maxResults because we'll filter by IF
      // Strategy: fetch works in pages, collect source IDs, check IF, filter
      const allWorks: any[] = [];
      const filteredResults: LiteratureResult[] = [];
      const sourceIFCache = new Map<string, number>();
      let cursor = "*";
      let totalFetched = 0;
      const fetchLimit = 5000; // Max works to scan from OpenAlex
      const perPage = 100;

      // Set SSE headers for progress updates
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const sendProgress = (msg: string) => {
        res.write(`data: ${JSON.stringify({ type: "progress", message: msg })}\n\n`);
      };

      sendProgress(`正在搜尋「${query}」相關文獻...`);

      while (totalFetched < fetchLimit && filteredResults.length < maxResults) {
        const apiUrl = `${OPENALEX_BASE}/works?search=${encodeURIComponent(query)}&filter=from_publication_date:${fromDate},type:article&per_page=${perPage}&cursor=${cursor}&select=id,title,authorships,primary_location,abstract_inverted_index,publication_date&sort=relevance_score:desc`;
        
        let data: any;
        try {
          const apiRes = await fetch(apiUrl);
          if (!apiRes.ok) {
            const errText = await apiRes.text();
            res.write(`data: ${JSON.stringify({ type: "error", message: `OpenAlex API 錯誤: ${apiRes.status}` })}\n\n`);
            res.end();
            return;
          }
          data = await apiRes.json();
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", message: "無法連接 OpenAlex API" })}\n\n`);
          res.end();
          return;
        }

        const works = data.results || [];
        if (works.length === 0) break;

        // Collect unique source IDs we haven't cached yet
        const newSourceIds = new Set<string>();
        for (const work of works) {
          const sourceId = work.primary_location?.source?.id;
          if (sourceId && !sourceIFCache.has(sourceId)) {
            newSourceIds.add(sourceId);
          }
        }

        // Batch fetch IF for new sources
        if (newSourceIds.size > 0) {
          sendProgress(`正在查詢 ${newSourceIds.size} 個期刊的 Impact Factor...`);
          const newIFs = await fetchSourceIFs(Array.from(newSourceIds));
          for (const [id, ifVal] of newIFs) {
            sourceIFCache.set(id, ifVal);
          }
        }

        // Filter works by IF
        for (const work of works) {
          if (filteredResults.length >= maxResults) break;

          const sourceId = work.primary_location?.source?.id;
          const ifValue = sourceId ? (sourceIFCache.get(sourceId) ?? null) : null;

          if (ifValue !== null && ifValue >= minIF) {
            const authors = (work.authorships || [])
              .map((a: any) => a.author?.display_name)
              .filter(Boolean)
              .join(", ");

            filteredResults.push({
              title: stripHtml(work.title || ""),
              author: authors,
              abstract: reconstructAbstract(work.abstract_inverted_index),
              journal: work.primary_location?.source?.display_name || "",
              impactFactor: Math.round(ifValue * 100) / 100,
              pubUrl: work.primary_location?.landing_page_url || "",
              pdfUrl: work.primary_location?.pdf_url || "",
              publicationDate: work.publication_date || "",
            });
          }
        }

        totalFetched += works.length;
        cursor = data.meta?.next_cursor;
        if (!cursor) break;

        sendProgress(`已掃描 ${totalFetched} 篇文獻，找到 ${filteredResults.length} 篇符合 IF≥${minIF} 的結果...`);

        // Small delay to be polite to OpenAlex
        await new Promise(r => setTimeout(r, 200));
      }

      sendProgress(`搜尋完成！共找到 ${filteredResults.length} 篇符合條件的文獻`);

      // Send final results
      res.write(`data: ${JSON.stringify({ type: "done", results: filteredResults, totalScanned: totalFetched })}\n\n`);
      res.end();

    } catch (error: any) {
      console.error("Search error:", error);
      res.write(`data: ${JSON.stringify({ type: "error", message: error.message || "伺服器錯誤" })}\n\n`);
      res.end();
    }
  });

  // Export results as TXT file download
  app.post("/api/export", async (req, res) => {
    try {
      const { results, query } = req.body as { results: LiteratureResult[], query: string };
      if (!results || !Array.isArray(results)) {
        return res.status(400).json({ error: "No results to export" });
      }

      const header = "title\tauthor\tabstract\tjournal\tIF\tpub_url\tpdf_url";
      const rows = results.map((r: LiteratureResult) =>
        [
          r.title,
          r.author,
          (r.abstract || "").replace(/\t/g, " ").replace(/\n/g, " "),
          r.journal,
          r.impactFactor?.toString() || "",
          r.pubUrl,
          r.pdfUrl,
        ].join("\t")
      );
      const content = "\uFEFF" + [header, ...rows].join("\n");

      const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const sanitizedQuery = (query || "search").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 30);
      const filename = `${sanitizedQuery}_${timestamp}.txt`;

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(content);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Export results as PDF
  app.post("/api/export/pdf", async (req, res) => {
    try {
      const { results, query, minIF } = req.body as {
        results: LiteratureResult[];
        query: string;
        minIF?: number;
      };
      if (!results || !Array.isArray(results)) {
        return res.status(400).json({ error: "No results to export" });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .slice(0, 14);
      const sanitizedQuery = (query || "search")
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
        .slice(0, 30);
      const filename = `${sanitizedQuery}_${timestamp}.pdf`;
      const outputPath = path.join(os.tmpdir(), filename);

      const scriptPath = path.resolve(
        __dirname,
        process.env.NODE_ENV === "production" ? "../scripts/export_pdf.py" : "../scripts/export_pdf.py"
      );

      const payload = JSON.stringify({
        query,
        results,
        minIF: minIF ?? 4,
        outputPath,
      });

      const result = await runPython(scriptPath, payload);
      if (!result.ok) {
        return res.status(500).json({ error: "PDF generation failed" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("end", () => {
        fs.unlink(outputPath, () => {});
      });
    } catch (error: any) {
      console.error("PDF export error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Export results as DOCX
  app.post("/api/export/docx", async (req, res) => {
    try {
      const { results, query, minIF } = req.body as {
        results: LiteratureResult[];
        query: string;
        minIF?: number;
      };
      if (!results || !Array.isArray(results)) {
        return res.status(400).json({ error: "No results to export" });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .slice(0, 14);
      const sanitizedQuery = (query || "search")
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
        .slice(0, 30);
      const filename = `${sanitizedQuery}_${timestamp}.docx`;
      const outputPath = path.join(os.tmpdir(), filename);

      const scriptPath = path.resolve(
        __dirname,
        process.env.NODE_ENV === "production" ? "../scripts/export_docx.py" : "../scripts/export_docx.py"
      );

      const payload = JSON.stringify({
        query,
        results,
        minIF: minIF ?? 4,
        outputPath,
      });

      const result = await runPython(scriptPath, payload);
      if (!result.ok) {
        return res.status(500).json({ error: "DOCX generation failed" });
      }

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("end", () => {
        fs.unlink(outputPath, () => {});
      });
    } catch (error: any) {
      console.error("DOCX export error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}

/** Spawn a Python script, pipe JSON payload via stdin, return parsed stdout. */
function runPython(
  scriptPath: string,
  payload: string
): Promise<{ ok: boolean; path?: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("Python stderr:", stderr);
        resolve({ ok: false });
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ ok: true });
        }
      }
    });
    proc.on("error", (err) => reject(err));
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
