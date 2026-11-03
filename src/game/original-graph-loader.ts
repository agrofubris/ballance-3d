import type { OriginalGraphData } from './original-graph.ts'

const graphCache = new Map<string, Promise<OriginalGraphData | undefined>>()

async function loadJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    return await response.json() as T
  } catch {
    return undefined
  }
}

/** Load a generated behavior graph from the local original pack. */
export function loadOriginalGraph(name: string): Promise<OriginalGraphData | undefined> {
  const key = name.toLowerCase()
  let pending = graphCache.get(key)
  if (!pending) {
    pending = loadJson<OriginalGraphData>(`/original/graphs/${key}.json`)
    graphCache.set(key, pending)
  }
  return pending
}
