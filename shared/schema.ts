import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const searchHistory = sqliteTable("search_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  resultCount: integer("result_count").notNull(),
  searchedAt: text("searched_at").notNull(),
});

export const insertSearchHistorySchema = createInsertSchema(searchHistory).omit({ id: true });
export type InsertSearchHistory = z.infer<typeof insertSearchHistorySchema>;
export type SearchHistory = typeof searchHistory.$inferSelect;

// Shared types for API responses (not DB tables)
export const literatureResultSchema = z.object({
  title: z.string(),
  author: z.string(),
  abstract: z.string(),
  journal: z.string(),
  impactFactor: z.number().nullable(),
  pubUrl: z.string(),
  pdfUrl: z.string(),
  publicationDate: z.string(),
});

export type LiteratureResult = z.infer<typeof literatureResultSchema>;

export const searchRequestSchema = z.object({
  query: z.string().min(1, "搜尋主題不能為空"),
  minIF: z.number().default(4),
  yearsBack: z.number().default(5),
  maxResults: z.number().default(500),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
