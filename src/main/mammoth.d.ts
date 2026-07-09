/**
 * mammoth (.docx → text/html) 的最小类型声明。
 * 只覆盖 Kun 用到的 extractRawText / convertToHtml 两个 API。
 */
declare module 'mammoth' {
  export interface ConvertResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }

  export interface ConvertOptions {
    /** .docx 文件的绝对路径 */
    path?: string
    /** 已读入内存的 .docx 字节 */
    buffer?: Buffer
    arrayBuffer?: ArrayBuffer
    styleMap?: string | string[]
    includeDefaultStyleMap?: boolean
    includeEmbeddedStyleMap?: boolean
  }

  export function extractRawText(options: ConvertOptions): Promise<ConvertResult>
  export function convertToHtml(options: ConvertOptions): Promise<ConvertResult>

  const mammoth: {
    extractRawText: typeof extractRawText
    convertToHtml: typeof convertToHtml
  }
  export default mammoth
}
