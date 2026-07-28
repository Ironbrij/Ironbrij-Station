export const QUOTES: { text: string; author: string }[] = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  {
    text: "Success is the sum of small efforts, repeated day in and day out.",
    author: "Robert Collier",
  },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt" },
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { text: "Small progress is still progress.", author: "Anonymous" },
  {
    text: "Great things are done by a series of small things brought together.",
    author: "Vincent Van Gogh",
  },
];

export function randomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}
