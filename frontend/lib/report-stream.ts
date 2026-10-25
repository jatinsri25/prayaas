export type ReportStage = 'received' | 'transcribing' | 'preparing' | 'generating' | 'refining' | 'checking';

const STAGES: ReportStage[] = ['received', 'transcribing', 'preparing', 'generating', 'refining', 'checking'];

// XHR exposes cumulative responseText, including partial JSON at chunk boundaries.
export class ReportStreamReader<T> {
  private offset = 0;
  private result: T | undefined;
  private failure: Error | undefined;

  constructor(private onProgress: (stage: ReportStage) => void) {}

  read(text: string) {
    let end = text.indexOf('\n', this.offset);
    while (end >= 0) {
      const line = text.slice(this.offset, end).trim();
      this.offset = end + 1;
      if (line && !this.failure) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress' && STAGES.includes(event.stage)) this.onProgress(event.stage);
          if (event.type === 'complete') this.result = event.draft;
          if (event.type === 'error') this.failure = new Error(event.detail || 'AI processing failed. Please try again.');
        } catch {
          this.failure = new Error('The AI response was interrupted. Please try again.');
        }
      }
      end = text.indexOf('\n', this.offset);
    }
  }

  finish(): T {
    if (this.failure) throw this.failure;
    if (!this.result) throw new Error('The AI response was interrupted. Your input is safe; please try again.');
    return this.result;
  }
}
