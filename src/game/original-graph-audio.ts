import type { GraphAudioBinding, GraphSoundSettings } from './original-graph-bindings.ts'

export interface GraphAudioSink {
  play(name: string, options?: { loop?: boolean; volume?: number }): void
  stop(name: string): void
  gain?(name: string, gain: number): void
  pitch?(name: string, pitch: number): void
  pan?(name: string, pan: number): void
  properties?(name: string): GraphSoundSettings | undefined
  playing?(name: string): boolean
}

/** Adapts an engine audio sink to the graph runtime's audio contract. */
export class OriginalGraphAudio implements GraphAudioBinding {
  private readonly sink: GraphAudioSink

  constructor(sink: GraphAudioSink) {
    this.sink = sink
  }

  play(name: string, options?: { loop?: boolean; volume?: number }): void {
    this.sink.play(name, options)
  }

  stop(name: string): void {
    this.sink.stop(name)
  }

  gain(name: string, gain: number): void {
    this.sink.gain?.(name, gain)
  }

  pitch(name: string, pitch: number): void {
    this.sink.pitch?.(name, pitch)
  }

  pan(name: string, pan: number): void {
    this.sink.pan?.(name, pan)
  }

  properties(name: string): GraphSoundSettings | undefined {
    return this.sink.properties?.(name)
  }

  playing(name: string): boolean | undefined {
    return this.sink.playing?.(name)
  }
}

export function graphAudioFrom(sink: GraphAudioSink): OriginalGraphAudio {
  return new OriginalGraphAudio(sink)
}
