export interface DocChunk {
  chunkIndex: number;
  headingPath: string;
  content: string;
}

export interface EmbeddedChunk extends DocChunk {
  embedding: number[];
}

export interface RetrievedChunk {
  id: string;
  source: string;
  headingPath: string;
  content: string;
  similarity: number;
}

export interface RagAnswer {
  answer: string;
  sources: { source: string; heading: string }[];
  answered: boolean; // false for refusals, greetings and "here's what I can help with"
}

export interface DocumentSummary {
  id: string;
  source: string;
  status: "processing" | "ready" | "failed";
  error: string | null;
  chunks: number;
  createdAt: string;
}
