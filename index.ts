import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { s3 } from './s3.js'
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import Stripe from 'stripe'
import { S3RequestPresigner } from "@aws-sdk/s3-request-presigner"
import { HttpRequest } from "@aws-sdk/protocol-http"
import { renderProduction } from './render.js'

const app = express()

// Health
app.get('/health', (_req, res) => res.json({ ok: true }))

// Webhook (raw body!) – kommt VOR dem globalen JSON-Parser
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' })
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'] as string | undefined
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!sig || !secret) return res.status(400).send('missing signature or secret')
    const event = stripe.webhooks.constructEvent(req.body, sig, secret)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const md: any = session.metadata || {}
      const cropArea = md.cropArea ? JSON.parse(md.cropArea) : null
      const imageInfo = md.imageInfo ? JSON.parse(md.imageInfo) : null
      const wmm = Number(md.wmm || 0)
      const hmm = Number(md.hmm || 0)
      if (md.objectKey && wmm && hmm) {
        try {
          const result = await renderProduction({
            bucket: process.env.S3_BUCKET!,
            objectKey: md.objectKey,
            wmm, hmm, cropArea, imageInfo, outFormat: 'jpg'
          })
          console.log('Rendered production file:', result)
        } catch (e:any) {
          console.error('Render failed:', e.message)
        }
      } else {
        console.warn('Missing metadata for render')
      }
    }
    res.json({ received: true })
  } catch (err:any) {
    console.error(err.message)
    res.status(400).send(`Webhook Error: ${err.message}`)
  }
})

// Ab hier normaler JSON‑Parser & CORS
app.use(morgan('dev'))
app.use(express.json())
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }))

// Presigned Upload (PUT)
app.post('/assets/sign', async (req, res) => {
  try {
    const { filename, contentType } = req.body || {}
    if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' })
    const bucket = process.env.S3_BUCKET!
    const objectKey = `raw/${Date.now()}_${filename}`

    const presigner = new S3RequestPresigner({ ...s3.config })
    const reqToSign = new HttpRequest({
      ...s3.config,
      protocol: (process.env.S3_ENDPOINT || '').startsWith('https') ? 'https:' : 'http:',
      method: 'PUT',
      path: `/${bucket}/${objectKey}`,
      headers: { 'content-type': contentType },
      hostname: new URL(process.env.S3_ENDPOINT!).host,
    })
    const url = await presigner.presign(reqToSign, { expiresIn: 60 * 5 })
    res.json({ url: url.toString(), objectKey })
  } catch (e:any) {
    console.error(e)
    res.status(500).json({ error: 'signing_failed', detail: e?.message })
  }
})

// Checkout (Stripe) – mit Metadaten
app.post('/checkout/session', async (req, res) => {
  try {
    const { items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'no_items' })
    const i = items[0]

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: `ORDER-${Date.now()}`,
      metadata: {
        objectKey: i.objectKey,
        sizeId: i.size,
        wmm: String(i.wmm || ''),
        hmm: String(i.hmm || ''),
        cropArea: JSON.stringify(i.cropArea || {}),
        imageInfo: JSON.stringify(i.imageInfo || {})
      },
      line_items: [{
        quantity: i.qty,
        price_data: {
          currency: (i.currency || 'eur').toLowerCase(),
          product_data: { name: `${i.product} (${i.size})` },
          unit_amount: Math.round(i.price * 100),
        },
      }],
      success_url: process.env.SUCCESS_URL || 'https://example.com/success',
      cancel_url: process.env.CANCEL_URL || 'https://example.com/cancel',
    })

    res.json({ url: session.url })
  } catch (err:any) {
    console.error(err)
    res.status(500).json({ error: 'stripe_failed', detail: err.message })
  }
})

// Basic Auth for /admin/*
function basicAuth(req: any, res: any, next: any) {
  const user = process.env.ADMIN_USER || ''
  const pass = process.env.ADMIN_PASS || ''
  const hdr = req.headers['authorization'] || ''
  if (!hdr.startsWith('Basic ')) return unauthorized(res)
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8')
  const [u, p] = decoded.split(':')
  if (u === user && p === pass) return next()
  return unauthorized(res)
}
function unauthorized(res: any) {
  res.set('WWW-Authenticate', 'Basic realm="Admin"')
  return res.status(401).send('Auth required')
}

// Admin: list files
app.get('/admin/files', basicAuth, async (_req, res) => {
  try {
    const bucket = process.env.S3_BUCKET!
    const prefixes = ['prod/', 'hotfolder/']
    const out:any = {}
    for (const Prefix of prefixes) {
      const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix }))
      out[Prefix.replace('/', '')] = (resp.Contents || [])
        .filter(o => o.Key && !o.Key.endsWith('/'))
        .map(o => ({ key: o.Key, size: o.Size, lastModified: o.LastModified }))
    }
    res.json(out)
  } catch (e:any) {
    console.error(e)
    res.status(500).json({ error: 'list_failed', detail: e.message })
  }
})

// Admin: sign download
app.get('/admin/sign', basicAuth, async (req, res) => {
  try {
    const key = req.query.key as string
    if (!key) return res.status(400).json({ error: 'missing key' })
    const bucket = process.env.S3_BUCKET!
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
    const url = await getSignedUrl(s3 as any, cmd, { expiresIn: 60 * 5 })
    res.json({ url })
  } catch (e:any) {
    console.error(e)
    res.status(500).json({ error: 'sign_failed', detail: e.message })
  }
})

const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`API running on :${port}`))
