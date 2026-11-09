// Shared test fixtures shaped like real Nuvio data.

export function sampleCollections() {
  return [
    {
      id: 'collections.genres',
      title: 'Genres',
      pinToTop: true,
      viewMode: 'ROWS',
      showAllTab: true,
      focusGlowEnabled: true,
      folders: [
        {
          id: 'f-action',
          title: 'Action',
          sources: ['a', 'b'],
          hideTitle: true,
          tileShape: 'POSTER',
          coverEmoji: '💥',
          focusGifUrl: 'https://ai.example/action.gif',
          titleLogoUrl: 'https://ai.example/action-logo.png',
          coverImageUrl: 'https://ai.example/action.png',
          catalogSources: [{ type: 'movie', genre: 'Action', addonId: 'tmdb', catalogId: 'tmdb.top' }],
          focusGifEnabled: true,
          heroBackdropUrl: 'https://ai.example/action-hero.png',
          someFutureField: { nested: [1, 2, 3] },
        },
        {
          id: 'f-horror',
          title: 'Horror',
          sources: [],
          hideTitle: false,
          tileShape: 'LANDSCAPE',
          coverEmoji: '👻',
          catalogSources: [{ type: 'movie', genre: 'Horror', addonId: 'tmdb', catalogId: 'tmdb.top' }],
        },
      ],
    },
    {
      id: 'collections.streaming',
      title: 'Streaming',
      pinToTop: false,
      viewMode: 'GRID',
      showAllTab: false,
      focusGlowEnabled: false,
      folders: [
        {
          id: 'f-netflix',
          title: 'Netflix',
          sources: null,
          hideTitle: true,
          tileShape: 'POSTER',
          coverEmoji: null,
          focusGifUrl: null,
          titleLogoUrl: null,
          coverImageUrl: null,
          catalogSources: [{ type: 'series', genre: null, addonId: 'x', catalogId: 'netflix.popular' }],
          focusGifEnabled: false,
          heroBackdropUrl: null,
        },
      ],
    },
  ];
}

export const BACKDROP = 'https://images.metahub.space/background/large/tt0468569/img';
