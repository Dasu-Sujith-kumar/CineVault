export interface SearchResult {
  id: string;
  title: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  durationMinutes: number;
  rating: number;
  year: string;
  genre: string[];
  mediaType: "movie" | "tv";
}

const POSTERS = [
  "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=300&h=450&fit=crop",
  "https://images.unsplash.com/photo-1485846234645-a62644f84728?w=300&h=450&fit=crop",
  "https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=300&h=450&fit=crop",
  "https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=300&h=450&fit=crop",
  "https://images.unsplash.com/photo-1524712245354-2c4e5e7121c0?w=300&h=450&fit=crop",
  "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=300&h=450&fit=crop",
];

const BACKDROPS = [
  "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1280&h=720&fit=crop",
  "https://images.unsplash.com/photo-1485846234645-a62644f84728?w=1280&h=720&fit=crop",
  "https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=1280&h=720&fit=crop",
];

const CATALOG: SearchResult[] = [
  {
    id: "local-last-frontier",
    title: "The Last Frontier",
    overview: "A survival thriller about a remote town, a sudden shutdown, and the people trying to hold the line.",
    posterUrl: POSTERS[0],
    backdropUrl: BACKDROPS[0],
    durationMinutes: 128,
    rating: 7.9,
    year: "2024",
    genre: ["Thriller", "Drama"],
    mediaType: "movie",
  },
  {
    id: "local-crimson-dawn",
    title: "Crimson Dawn",
    overview: "A lean revenge story set across one long night in a city that never quite settles down.",
    posterUrl: POSTERS[1],
    backdropUrl: BACKDROPS[1],
    durationMinutes: 112,
    rating: 6.8,
    year: "2022",
    genre: ["Action", "Crime"],
    mediaType: "movie",
  },
  {
    id: "local-echoes-of-tomorrow",
    title: "Echoes of Tomorrow",
    overview: "A grounded sci-fi mystery about memory drift, parallel decisions, and one very bad invention.",
    posterUrl: POSTERS[2],
    backdropUrl: BACKDROPS[2],
    durationMinutes: 134,
    rating: 8.1,
    year: "2023",
    genre: ["Sci-Fi", "Mystery"],
    mediaType: "movie",
  },
  {
    id: "local-stellar-odyssey",
    title: "Stellar Odyssey",
    overview: "A wide-screen space adventure built around one damaged crew and a mission that keeps mutating.",
    posterUrl: POSTERS[3],
    backdropUrl: BACKDROPS[0],
    durationMinutes: 141,
    rating: 7.4,
    year: "2021",
    genre: ["Adventure", "Sci-Fi"],
    mediaType: "movie",
  },
  {
    id: "local-shadow-protocol",
    title: "Shadow Protocol",
    overview: "An espionage thriller where every favor costs too much and every ally is temporary.",
    posterUrl: POSTERS[4],
    backdropUrl: BACKDROPS[1],
    durationMinutes: 117,
    rating: 7.2,
    year: "2020",
    genre: ["Thriller", "Action"],
    mediaType: "movie",
  },
  {
    id: "local-midnight-reverie",
    title: "Midnight Reverie",
    overview: "A quiet late-night drama about grief, music, and the strange calm before a life resets.",
    posterUrl: POSTERS[5],
    backdropUrl: BACKDROPS[2],
    durationMinutes: 109,
    rating: 7.6,
    year: "2019",
    genre: ["Drama", "Romance"],
    mediaType: "movie",
  },
  {
    id: "local-dark-waters",
    title: "Dark Waters",
    overview: "A serial investigation that keeps circling back to the same coastal town and the same missing week.",
    posterUrl: POSTERS[0],
    backdropUrl: BACKDROPS[1],
    durationMinutes: 52,
    rating: 8,
    year: "2021",
    genre: ["Thriller", "Mystery"],
    mediaType: "tv",
  },
  {
    id: "local-crown-files",
    title: "The Crown Files",
    overview: "A legal-political series where every season is built around one scandal and the people buried under it.",
    posterUrl: POSTERS[1],
    backdropUrl: BACKDROPS[2],
    durationMinutes: 49,
    rating: 7.5,
    year: "2020",
    genre: ["Drama", "Political"],
    mediaType: "tv",
  },
  {
    id: "local-cyber-chase",
    title: "Cyber Chase",
    overview: "A fast cybercrime show about digital clean-up crews, bad startups, and messy consequences.",
    posterUrl: POSTERS[2],
    backdropUrl: BACKDROPS[0],
    durationMinutes: 45,
    rating: 7.1,
    year: "2024",
    genre: ["Crime", "Sci-Fi"],
    mediaType: "tv",
  },
  {
    id: "local-parallel-lines",
    title: "Parallel Lines",
    overview: "Two detectives in different timelines keep solving parts of the same case without knowing it.",
    posterUrl: POSTERS[3],
    backdropUrl: BACKDROPS[2],
    durationMinutes: 54,
    rating: 8.3,
    year: "2023",
    genre: ["Mystery", "Sci-Fi"],
    mediaType: "tv",
  },
  {
    id: "local-night-shift",
    title: "Night Shift",
    overview: "A character-driven hospital drama set almost entirely on the overnight team no one sees.",
    posterUrl: POSTERS[4],
    backdropUrl: BACKDROPS[1],
    durationMinutes: 47,
    rating: 7.3,
    year: "2018",
    genre: ["Drama", "Medical"],
    mediaType: "tv",
  },
  {
    id: "local-horizon",
    title: "Horizon",
    overview: "A frontier series about surveying crews, hostile terrain, and the corporations behind both.",
    posterUrl: POSTERS[5],
    backdropUrl: BACKDROPS[0],
    durationMinutes: 58,
    rating: 7.7,
    year: "2022",
    genre: ["Adventure", "Drama"],
    mediaType: "tv",
  },
];

function scoreResult(result: SearchResult, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return 0;

  return tokens.reduce((score, token) => {
    let next = 0;
    if (result.title.toLowerCase().includes(token)) next += 6;
    if (result.genre.some((genre) => genre.toLowerCase().includes(token))) next += 2;
    if (result.overview.toLowerCase().includes(token)) next += 1;
    return score + next;
  }, 0);
}

export function searchMedia(
  query: string,
  mediaType: "movie" | "tv" | "all" = "all"
): SearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  return CATALOG
    .filter((result) => mediaType === "all" || result.mediaType === mediaType)
    .map((result) => ({ result, score: scoreResult(result, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .map((entry) => entry.result);
}
