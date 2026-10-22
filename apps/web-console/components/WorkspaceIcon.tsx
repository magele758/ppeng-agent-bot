export function WorkspaceIcon({ kind }: { kind: 'quote' | 'plus' | 'search' | 'select' | 'panel' | 'close' | 'trash' }) {
  const paths = {
    quote: 'M9 10H5V7h5V4H2v10h5v6h3v-7a3 3 0 0 0-1-3Zm12 0h-4V7h5V4h-8v10h5v6h3v-7a3 3 0 0 0-1-3Z',
    plus: 'M12 4v16M4 12h16', search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    select: 'M3 5h3v3H3zM10 6h11M3 16l2 2 4-5M12 17h9', panel: 'M3 4h18v16H3zM15 4v16', close: 'M6 6l12 12M18 6L6 18',
    trash: 'M4 7h16M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5'
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
