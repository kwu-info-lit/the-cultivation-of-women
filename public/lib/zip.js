// Minimal read-only ZIP reader for EPUB files.
// Supports "stored" (0) and "deflate" (8) entries; decompression uses the
// browser's native DecompressionStream, so no third-party library is needed.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export class ZipArchive {
    #buffer
    #view
    #entries = new Map()

    constructor(buffer) {
        this.#buffer = buffer
        this.#view = new DataView(buffer)
        this.#readCentralDirectory()
    }

    get names() {
        return [...this.#entries.keys()]
    }

    size(name) {
        return this.#entries.get(name)?.size ?? 0
    }

    has(name) {
        return this.#entries.has(name)
    }

    async bytes(name) {
        const entry = this.#entries.get(name)
        if (!entry) throw new Error(`EPUB内にファイルがありません: ${name}`)
        const view = this.#view
        const offset = entry.localOffset
        if (view.getUint32(offset, true) !== LOCAL_SIGNATURE)
            throw new Error(`ZIPのローカルヘッダが不正です: ${name}`)
        const nameLength = view.getUint16(offset + 26, true)
        const extraLength = view.getUint16(offset + 28, true)
        const start = offset + 30 + nameLength + extraLength
        const data = new Uint8Array(this.#buffer, start, entry.compressedSize)

        if (entry.method === 0) return data.slice()
        if (entry.method !== 8) throw new Error(`未対応の圧縮形式です (${entry.method}): ${name}`)

        const stream = new Blob([data]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
    }

    async text(name) {
        return new TextDecoder('utf-8').decode(await this.bytes(name))
    }

    async blob(name, type = '') {
        return new Blob([await this.bytes(name)], { type })
    }

    #readCentralDirectory() {
        const view = this.#view
        const length = view.byteLength
        // The end-of-central-directory record is at least 22 bytes and may be
        // followed by a comment of up to 65535 bytes.
        let eocd = -1
        for (let i = length - 22; i >= Math.max(0, length - 22 - 0xffff); i--) {
            if (view.getUint32(i, true) === EOCD_SIGNATURE) {
                eocd = i
                break
            }
        }
        if (eocd < 0) throw new Error('ZIPファイルとして読み込めません')

        const count = view.getUint16(eocd + 10, true)
        let offset = view.getUint32(eocd + 16, true)
        const decoder = new TextDecoder('utf-8')

        for (let i = 0; i < count; i++) {
            if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE)
                throw new Error('ZIPの中央ディレクトリが不正です')
            const method = view.getUint16(offset + 10, true)
            const compressedSize = view.getUint32(offset + 20, true)
            const size = view.getUint32(offset + 24, true)
            const nameLength = view.getUint16(offset + 28, true)
            const extraLength = view.getUint16(offset + 30, true)
            const commentLength = view.getUint16(offset + 32, true)
            const localOffset = view.getUint32(offset + 42, true)
            const name = decoder.decode(new Uint8Array(this.#buffer, offset + 46, nameLength))
            this.#entries.set(name, { method, compressedSize, size, localOffset })
            offset += 46 + nameLength + extraLength + commentLength
        }
    }
}
