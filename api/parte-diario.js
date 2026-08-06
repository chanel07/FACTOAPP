// /api/parte-diario.js
// "El parte del barrio": cada mañana lee los factos de las últimas 24 horas,
// le pide a Gemini un resumen con tono de vecino y lo envía por push a todos.
// Lo dispara automáticamente el cron de Vercel (ver vercel.json).
//
// Variables de entorno que usa (las dos primeras ya existen en tu Vercel):
//   GEMINI_API_KEY, ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY
//   CRON_SECRET (nueva, recomendada): una clave inventada por ti para que
//   nadie más pueda disparar el parte a mano y llenar de spam a tus usuarios.

const SUPABASE_URL = 'https://nwanfvsjusdeissqjlat.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_iBkcTifMwPU2My1atR_hYQ_rKF6QPRj';

const NOMBRES_CAT = {
  peligro: 'Peligro', servicios: 'Luz / Agua', vias: 'Vías', parche: 'Parche',
  eventos: 'Eventos', mascotas: 'Mascotas', transporte: 'Transporte'
};

const MODELOS = [
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
];

export default async function handler(req, res) {
  // --- Seguridad: solo el cron de Vercel (o tú con la clave) puede disparar esto ---
  if (process.env.CRON_SECRET) {
    const porHeader = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
    const porQuery = req.query && req.query.clave === process.env.CRON_SECRET;
    if (!porHeader && !porQuery) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  try {
    // --- 1. Leer los factos de las últimas 24 horas en Supabase ---
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const factosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/factos?select=categoria,zona,texto,resuelto,created_at&created_at=gte.${encodeURIComponent(desde)}&order=created_at.desc&limit=40`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );
    if (!factosRes.ok) throw new Error('No se pudieron leer los factos de Supabase');
    const factos = await factosRes.json();

    // --- 2. Armar el resumen ---
    let resumen;

    if (!factos || factos.length === 0) {
      resumen = 'Ayer fue un día tranquilo en el barrio 🌴 Sin novedades reportadas. Si ves algo hoy, tira el facto.';
    } else {
      const lineas = factos.map(f =>
        `- [${NOMBRES_CAT[f.categoria] || f.categoria}] en ${f.zona}${f.resuelto ? ' (ya resuelto)' : ''}: ${f.texto}`
      ).join('\n');

      const prompt = `Eres el vocero vecinal de "Facto", una app comunitaria de Santa Marta, Colombia. Con la lista de reportes de las últimas 24 horas, escribe el "parte del barrio" de esta mañana.

Reglas estrictas:
- Máximo 2 frases y 220 caracteres en total.
- Tono cercano y colombiano, como un vecino informado, sin sonar a robot ni a noticiero formal.
- Prioriza lo importante: peligro y servicios primero, luego vías/transporte, luego mascotas y eventos.
- Menciona lo resuelto solo si vale la pena celebrarlo.
- Sin hashtags, sin markdown, sin comillas. Puedes usar 1 o 2 emojis.
- Responde SOLO con el texto del parte, nada más.

Reportes:
${lineas}`;

      resumen = null;
      for (const modelo of MODELOS) {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.4 }
            })
          }
        );
        const data = await geminiRes.json();
        if (geminiRes.ok) {
          resumen = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
          if (resumen) {
            console.log('Parte generado con el modelo:', modelo);
            break;
          }
        } else if (data?.error?.code === 404) {
          console.log(`Modelo ${modelo} no disponible, probando el siguiente...`);
          continue;
        } else {
          console.error('Error de Gemini:', data);
          break;
        }
      }

      // Si Gemini no pudo, armamos un resumen simple contando por categoría
      if (!resumen) {
        const conteo = {};
        factos.forEach(f => { conteo[f.categoria] = (conteo[f.categoria] || 0) + 1; });
        const partes = Object.entries(conteo)
          .map(([cat, n]) => `${n} de ${NOMBRES_CAT[cat] || cat}`)
          .join(', ');
        resumen = `Ayer el barrio reportó: ${partes}. Entra a Facto para ver el detalle.`;
      }

      // Seguro de longitud para que la push no salga cortada fea
      if (resumen.length > 240) resumen = resumen.slice(0, 237) + '...';
    }

    // --- 3. Enviar la push a todos ---
    const llave = process.env.ONESIGNAL_REST_API_KEY || '';
    const autorizacion = llave.startsWith('os_v2_') ? `Key ${llave}` : `Basic ${llave}`;

    const pushRes = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': autorizacion
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        included_segments: ['Total Subscriptions'],
        headings: { en: '☀️ El parte del barrio', es: '☀️ El parte del barrio' },
        contents: { en: resumen, es: resumen },
        url: 'https://factoapp-sigma.vercel.app'
      })
    });

    const pushData = await pushRes.json();
    if (!pushRes.ok) {
      console.error('Error de OneSignal:', pushData);
      return res.status(502).json({ error: 'OneSignal rechazó el parte', detalle: pushData });
    }

    return res.status(200).json({
      ok: true,
      factos_resumidos: factos.length,
      resumen,
      destinatarios: pushData.recipients
    });
  } catch (e) {
    console.error('Error generando el parte diario:', e);
    return res.status(500).json({ error: 'Error interno generando el parte' });
  }
}
