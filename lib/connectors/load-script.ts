// Load a third-party script once (Google's sign-in and picker libraries).
const loading = new Map<string, Promise<void>>();
export function loadScript(src: string): Promise<void> {
  if (!loading.has(src)) {
    loading.set(src, new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading.delete(src);
        reject(new Error(`Couldn't load ${src}`));
      };
      document.head.appendChild(s);
    }));
  }
  return loading.get(src)!;
}
