export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { para_tel, titulo, mensaje } = req.body;

  if (!para_tel || !mensaje) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const respuesta = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        include_aliases: { external_id: [para_tel] },
        target_channel: 'push',
        headings: { en: titulo || 'Facto' },
        contents: { en: mensaje }
      })
    });

    const data = await respuesta.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No se pudo enviar la notificación' });
  }
}
