/** UI <-> scene commands that are not world state (camera, panels, toasts). */
export interface BusEvents {
  center: { x: number; y: number };
  follow: { on?: boolean };
  followChanged: { on: boolean };
  dialog: { id: string | null };
  group: { id: string | null };
  toast: { text: string; big?: boolean };
  joined: void;
  camera: { x: number; y: number; w: number; h: number };
}

type Handler<T> = (p: T) => void;
const handlers = new Map<keyof BusEvents, Set<Handler<unknown>>>();

export const bus = {
  on<K extends keyof BusEvents>(ev: K, cb: Handler<BusEvents[K]>): () => void {
    let s = handlers.get(ev);
    if (!s) handlers.set(ev, (s = new Set()));
    s.add(cb as Handler<unknown>);
    return () => s!.delete(cb as Handler<unknown>);
  },
  emit<K extends keyof BusEvents>(ev: K, payload: BusEvents[K]): void {
    handlers.get(ev)?.forEach((cb) => cb(payload));
  },
};
