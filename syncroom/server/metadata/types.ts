import type { CatalogSection, Episode, MediaType, TitleDetail, TitleSummary } from '../../shared/types.ts';

export type BrowseSort = 'popular' | 'new' | 'rating';

export interface BrowseQuery {
  type: MediaType;
  genre?: string;
  year?: number;
  sort?: BrowseSort;
  page?: number;
}

export interface BrowseResult {
  items: TitleSummary[];
  hasMore: boolean;
}

/** A metadata provider: everything the catalogue UI needs. */
export interface MetadataProvider {
  id: string;
  name: string;
  attribution: string;
  genres(type: MediaType): string[];
  home(): Promise<CatalogSection[]>;
  browse(q: BrowseQuery): Promise<BrowseResult>;
  search(query: string, type?: MediaType): Promise<TitleSummary[]>;
  detail(type: MediaType, id: string): Promise<TitleDetail | null>;
  recommendations(detail: TitleDetail): Promise<TitleSummary[]>;
}

export function isFuture(date?: string): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  return Number.isFinite(t) && t > Date.now();
}

export function sortEpisodes(eps: Episode[]): Episode[] {
  return eps.sort((a, b) => (a.season === 0 ? 1e6 : a.season) - (b.season === 0 ? 1e6 : b.season) || a.episode - b.episode);
}
