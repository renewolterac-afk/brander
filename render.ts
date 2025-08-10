import sharp from 'sharp'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { jpegToPdf } from './pdf.js'

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' }
})

function mmToPx(mm: number, dpi = 300) { return Math.round(mm / 25.4 * dpi) }

export async function renderProduction(opts: {
  bucket: string
  objectKey: string
  wmm: number
  hmm: number
  cropArea?: { x:number; y:number; width:number; height:number } | null
  imageInfo?: { naturalWidth:number; naturalHeight:number; displayedWidth?:number; displayedHeight?:number } | null
  outFormat?: 'jpg' | 'png'
}) {
  const { bucket, objectKey, wmm, hmm, outFormat = 'jpg' } = opts
  let { cropArea } = opts
  const info = opts.imageInfo || null

  // Crop ggf. von Displaymaß auf Originalmaß hochskalieren
  if (cropArea && info && info.displayedWidth && info.displayedHeight && info.naturalWidth && info.naturalHeight) {
    const scaleX = info.naturalWidth / info.displayedWidth
    const scaleY = info.naturalHeight / info.displayedHeight
    cropArea = {
      x: Math.round(cropArea.x * scaleX),
      y: Math.round(cropArea.y * scaleY),
      width: Math.round(cropArea.width * scaleX),
      height: Math.round(cropArea.height * scaleY),
    }
  }

  // Original laden
  const src = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
  const inputBuffer = Buffer.from(await src.Body!.transformToByteArray())

  let img = sharp(inputBuffer, { failOn: 'none' }).withMetadata()

  if (cropArea && cropArea.width && cropArea.height) {
    img = img.extract({ left: Math.max(0, Math.round(cropArea.x)), top: Math.max(0, Math.round(cropArea.y)), width: Math.round(cropArea.width), height: Math.round(cropArea.height) })
  }

  const targetW = mmToPx(wmm, 300)
  const targetH = mmToPx(hmm, 300)
  img = img.resize(targetW, targetH, { fit: 'cover' })

  const outKey = `prod/${Date.now()}_${wmm}x${hmm}.${outFormat}`
  const outBuffer = outFormat === 'png' ? await img.png({ compressionLevel: 9 }).toBuffer()
                                       : await img.jpeg({ quality: 95 }).toBuffer()

  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: outKey, Body: outBuffer, ContentType: outFormat === 'png' ? 'image/png' : 'image/jpeg' }))

  // PDF erzeugen
  const { pdfBytes, outName } = await jpegToPdf({ jpegBuffer: outBuffer, widthMm: wmm, heightMm: hmm, bleedMm: 3, filenameBase: `print_${Date.now()}` })
  const pdfKey = `prod/${outName}`
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: pdfKey, Body: Buffer.from(pdfBytes), ContentType: 'application/pdf' }))

  // Hotfolder‑Kopie
  const hotKey = `hotfolder/${outName}`
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: hotKey, Body: Buffer.from(pdfBytes), ContentType: 'application/pdf' }))

  return { outKey, pdfKey, hotKey }
}
