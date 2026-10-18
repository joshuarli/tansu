declare module "*.css?raw" {
  const cssText: string;
  export default cssText;
}

declare module "*.html?raw" {
  const htmlText: string;
  export default htmlText;
}

declare module "*.js?raw" {
  const javascriptText: string;
  export default javascriptText;
}
