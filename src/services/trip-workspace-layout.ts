export const WORKSPACE_SPLIT_QUERY = '(min-width: 900px)';
export const WORKSPACE_PHONE_QUERY = '(max-width: 767px)';

export function matchesMediaQuery(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

export function isWorkspaceSplitViewport(): boolean {
  return matchesMediaQuery(WORKSPACE_SPLIT_QUERY);
}
