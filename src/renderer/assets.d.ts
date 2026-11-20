/** Imágenes importadas desde la interfaz (Vite las sirve y devuelve su URL). */
declare module '*.jpg' {
  const url: string
  export default url
}
