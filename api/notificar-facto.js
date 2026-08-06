// /api/notificar-facto.js
// Envía una notificación push a TODOS los usuarios suscritos cuando alguien publica un facto nuevo.
// Requiere en Vercel (proyecto Facto) las variables de entorno:
//   ONESIGNAL_APP_ID       -> el App ID de OneSignal del proyecto Facto
//   ONESIGNAL_REST_API_KEY -> la REST API Key de ese mismo proyecto OneSignal

const EMOJIS = {
  'Peligro': '🚨',
  'Luz / Agua': '💡',
  'Vías': '🚧',
  'Parche': '🔥',
  'Eventos': '🎉',
  'Mascotas': '🐶',
  'Transporte': '🚌'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { categoria, zona, texto } = req.body || {};

  if (!categoria || !zona || !texto) {
    return res.status(400).json({ error: 'Faltan datos (categoria, zona, texto)' });
  }

  const emoji = EMOJIS[categoria] || '📍';
  const titulo = `${emoji} Nuevo facto de ${categoria} en ${zona}`;
  // Recorto el texto para que la notificación no sea eterna
  const cuerpo = texto.length > 90 ? texto.slice(0, 87) + '...' : texto;

  try {
    const respuesta = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        included_segments: ['Total Subscriptions'],
        headings: { en: titulo, es: titulo },
        contents: { en: cuerpo, es: cuerpo },
        url: 'https://factoapp-sigma.vercel.app'
      })
    });

    const data = await respuesta.json();

    if (!respuesta.ok) {
      console.error('Error de OneSignal:', data);
      return res.status(502).json({ error: 'OneSignal rechazó la notificación', detalle: data });
    }

    return res.status(200).json({ ok: true, id: data.id, destinatarios: data.recipients });
  } catch (e) {
    console.error('Error enviando notificación de facto nuevo:', e);
    return res.status(500).json({ error: 'Error interno enviando la notificación' });
  }
}
