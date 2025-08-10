import { PDFDocument, rgb } from 'pdf-lib'

const MM_PER_INCH = 25.4
const PT_PER_INCH = 72

export function mmToPx(mm: number, dpi = 300) {
  return Math.round(mm / MM_PER_INCH * dpi)
}
export function mmToPt(mm: number) {
  return mm / MM_PER_INCH * PT_PER_INCH
}

/** Erzeugt 1‑seitiges PDF mit optionalem Anschnitt (Bleed). */
export async function jpegToPdf({
  jpegBuffer,
  widthMm,
  heightMm,
  bleedMm = 3,
  filenameBase = 'print'
}: {
  jpegBuffer: Buffer
  widthMm: number
  heightMm: number
  bleedMm?: number
  filenameBase?: string
}) {
  const pageWpt = mmToPt(widthMm + bleedMm*2)
  const pageHpt = mmToPt(heightMm + bleedMm*2)

  const pdf = await PDFDocument.create()
  const page = pdf.addPage([pageWpt, pageHpt])

  // Hintergrund (Anschnittbereich)
  page.drawRectangle({ x: 0, y: 0, width: pageWpt, height: pageHpt, color: rgb(1,1,1) })

  const embed = await pdf.embedJpg(jpegBuffer)
  const imgWpt = mmToPt(widthMm)
  const imgHpt = mmToPt(heightMm)

  page.drawImage(embed, {
    x: mmToPt(bleedMm),
    y: mmToPt(bleedMm),
    width: imgWpt,
    height: imgHpt
  })

  const pdfBytes = await pdf.save()
  const outName = `${filenameBase}_${widthMm}x${heightMm}_bleed${bleedMm}.pdf`
  return { pdfBytes, outName }
}
