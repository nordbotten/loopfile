declare module "handlebars/dist/cjs/handlebars.js" {
  type Template = (context: object) => string;

  const Handlebars: {
    parse(text: string): object;
    compile(text: string, options: { readonly noEscape: boolean }): Template;
  };

  export default Handlebars;
}
