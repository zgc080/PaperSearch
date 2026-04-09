import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Download, BookOpen, FlaskConical, ExternalLink, FileText, FileSpreadsheet, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { LiteratureResult } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export default function Home() {
  const [query, setQuery] = useState("");
  const [minIF, setMinIF] = useState(4);
  const [yearsBack, setYearsBack] = useState(5);
  const [maxResults, setMaxResults] = useState(500);
  const [results, setResults] = useState<LiteratureResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [totalScanned, setTotalScanned] = useState(0);
  const [searchDone, setSearchDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      toast({ title: "請輸入搜尋主題", variant: "destructive" });
      return;
    }

    setLoading(true);
    setResults([]);
    setProgress("正在連接 OpenAlex 學術資料庫...");
    setSearchDone(false);
    setTotalScanned(0);

    abortRef.current = new AbortController();

    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), minIF, yearsBack, maxResults }),
        signal: abortRef.current.signal,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("無法讀取回應");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line.replace(/^data: /, "").trim();
          if (!dataLine) continue;
          try {
            const msg = JSON.parse(dataLine);
            if (msg.type === "progress") {
              setProgress(msg.message);
            } else if (msg.type === "done") {
              setResults(msg.results);
              setTotalScanned(msg.totalScanned);
              setSearchDone(true);
            } else if (msg.type === "error") {
              toast({ title: "搜尋錯誤", description: msg.message, variant: "destructive" });
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        toast({ title: "搜尋失敗", description: err.message, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  }, [query, minIF, yearsBack, maxResults, toast]);

  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async (format: "txt" | "pdf" | "docx") => {
    if (results.length === 0) return;
    setExporting(true);

    const endpoint =
      format === "txt"
        ? `${API_BASE}/api/export`
        : `${API_BASE}/api/export/${format}`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results, query: query.trim(), minIF }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const fallbackExt = format === "txt" ? ".txt" : format === "pdf" ? ".pdf" : ".docx";
      const filename = filenameMatch?.[1] || `${query.trim()}_export${fallbackExt}`;

      // Try anchor click first, then window.open as fallback
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Also try window.open for iframe environments where anchor download is blocked
      try { window.open(blobUrl, "_blank"); } catch {}

      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      toast({ title: "匯出成功", description: `正在下載 ${filename}` });
    } catch (err: any) {
      toast({ title: "匯出失敗", description: err.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [results, query, minIF, toast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !loading) handleSearch();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2 text-primary">
            <FlaskConical className="h-5 w-5" />
            <span className="font-semibold text-base tracking-tight">PaperSearch</span>
          </div>
          <span className="text-xs text-muted-foreground">學術文獻搜尋工具</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Search Panel */}
        <Card data-testid="search-panel">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="h-4 w-4" />
              文獻搜尋
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Main search input */}
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                data-testid="input-query"
                placeholder="輸入搜尋主題，例如：Osteoporosis, Lupus..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1"
                disabled={loading}
              />
              <Button
                data-testid="button-search"
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className="w-full sm:w-auto sm:min-w-[100px]"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
                {loading ? "搜尋中" : "搜尋"}
              </Button>
            </div>

            {/* Filter row */}
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground text-xs">最低 IF</label>
                <Input
                  data-testid="input-min-if"
                  type="number"
                  min={0}
                  step={0.5}
                  value={minIF}
                  onChange={(e) => setMinIF(Number(e.target.value))}
                  className="h-9"
                  disabled={loading}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground text-xs">年份範圍</label>
                <div className="flex items-center gap-1">
                  <Input
                    data-testid="input-years"
                    type="number"
                    min={1}
                    max={20}
                    value={yearsBack}
                    onChange={(e) => setYearsBack(Number(e.target.value))}
                    className="h-9"
                    disabled={loading}
                  />
                  <span className="text-muted-foreground text-xs shrink-0">年內</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground text-xs">最大筆數</label>
                <Input
                  data-testid="input-max-results"
                  type="number"
                  min={1}
                  max={500}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Math.min(500, Number(e.target.value)))}
                  className="h-9"
                  disabled={loading}
                />
              </div>
            </div>

            {/* Progress */}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-progress">
                <Loader2 className="h-3 w-3 animate-spin" />
                {progress}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {searchDone && (
          <div className="space-y-4">
            {/* Stats bar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span>掃描 <strong className="text-foreground">{totalScanned}</strong> 篇</span>
                <span className="hidden sm:inline">·</span>
                <span>符合 <strong className="text-foreground">{results.length}</strong> 篇</span>
                <span className="hidden sm:inline">·</span>
                <span>IF ≥ {minIF}</span>
              </div>
              {results.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      data-testid="button-export"
                      variant="outline"
                      size="sm"
                      disabled={exporting}
                    >
                      {exporting ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 mr-1" />
                      )}
                      {exporting ? "匯出中..." : "匯出"}
                      <ChevronDown className="h-3 w-3 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      data-testid="export-txt"
                      onClick={() => handleExport("txt")}
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      匯出 TXT
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="export-pdf"
                      onClick={() => handleExport("pdf")}
                    >
                      <FileText className="h-4 w-4 mr-2 text-red-500" />
                      匯出 PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="export-docx"
                      onClick={() => handleExport("docx")}
                    >
                      <FileSpreadsheet className="h-4 w-4 mr-2 text-blue-500" />
                      匯出 Word
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            {results.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p>未找到符合條件的文獻</p>
                  <p className="text-xs mt-1">嘗試降低 IF 門檻或擴大年份範圍</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden md:block border border-border rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-results">
                      <thead>
                        <tr className="bg-muted/50 border-b border-border">
                          <th className="text-left px-3 py-2 font-medium w-8">#</th>
                          <th className="text-left px-3 py-2 font-medium min-w-[250px]">標題</th>
                          <th className="text-left px-3 py-2 font-medium min-w-[150px]">作者</th>
                          <th className="text-left px-3 py-2 font-medium min-w-[120px]">期刊</th>
                          <th className="text-center px-3 py-2 font-medium w-16">IF</th>
                          <th className="text-center px-3 py-2 font-medium w-20">日期</th>
                          <th className="text-center px-3 py-2 font-medium w-16">連結</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r, i) => (
                          <tr
                            key={i}
                            className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                            data-testid={`row-result-${i}`}
                          >
                            <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium leading-snug line-clamp-2">{r.title}</div>
                              {r.abstract && (
                                <div className="text-xs text-muted-foreground mt-1 line-clamp-1">{r.abstract}</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              <div className="line-clamp-2 text-xs">{r.author}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="text-xs line-clamp-1">{r.journal}</div>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <Badge variant="secondary" className="text-xs font-mono">
                                {r.impactFactor}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-center text-xs text-muted-foreground whitespace-nowrap">
                              {r.publicationDate?.slice(0, 10)}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {r.pubUrl && (
                                <a
                                  href={r.pubUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center text-primary hover:underline"
                                  data-testid={`link-pub-${i}`}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mobile card list */}
                <div className="md:hidden space-y-3" data-testid="mobile-results">
                  {results.map((r, i) => (
                    <Card key={i} className="overflow-hidden" data-testid={`card-result-${i}`}>
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-muted-foreground mb-0.5">#{i + 1}</div>
                            <div className="font-medium text-sm leading-snug line-clamp-3">{r.title}</div>
                          </div>
                          {r.pubUrl && (
                            <a
                              href={r.pubUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 p-2 text-primary hover:bg-muted rounded-md"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground line-clamp-1">{r.author}</div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="secondary" className="text-xs font-mono">IF {r.impactFactor}</Badge>
                          <span className="text-xs text-muted-foreground">{r.journal}</span>
                          <span className="text-xs text-muted-foreground">{r.publicationDate?.slice(0, 10)}</span>
                        </div>
                        {r.abstract && (
                          <div className="text-xs text-muted-foreground line-clamp-2 pt-1 border-t border-border/50">{r.abstract}</div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Info footer */}
        {!searchDone && !loading && (
          <div className="text-center py-16 text-muted-foreground space-y-2">
            <BookOpen className="h-12 w-12 mx-auto opacity-30" />
            <p className="text-sm">輸入主題關鍵字開始搜尋學術文獻</p>
            <p className="text-xs">資料來源：OpenAlex — IF 以 2yr Mean Citedness 為依據</p>
          </div>
        )}
      </main>
    </div>
  );
}
