// /api/moderar-foto.js
// Revisa con Gemini si una foto recién subida contiene contenido inapropiado
// (desnudez, contenido sexual, gore) ANTES de que el facto se publique.
// Requiere en Vercel (proyecto Facto) la variable de entorno:
//   GEMINI_API_KEY -> tu llave de Google AI Studio (sirve la misma de HuellaViva)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { foto_url } = req.body || {};
  if (!foto_url || !foto_url.startsWith('https://res.cloudinary.com/')) {
    return res.status(400).json({ error: 'Falta la foto_url válida de Cloudinary' });
  }

  try {
    // 1. Descargo la imagen y la convierto a base64 (Gemini la necesita así)
    const imgRes = await fetch(foto_url);
    if (!imgRes.ok) throw new Error('No se pudo descargar la foto');
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buffer.toString('base64');
    const mime = imgRes.headers.get('content-type') || 'image/jpeg';

    // 2. Le pregunto a Gemini
    const prompt = `Eres el moderador de contenido de una app comunitaria de barrio en Colombia donde vecinos reportan situaciones locales (cortes de servicios, seguridad, mascotas perdidas, eventos, estado de vías).

Analiza la imagen y responde SOLO con un JSON válido, sin texto adicional ni markdown:
{"apta": true o false, "razon": "explicación corta en español"}

La imagen NO es apta (apta: false) únicamente si contiene:
- Desnudez o contenido sexual de cualquier tipo
- Gore extremo o mutilaciones explícitas mostradas de forma gratuita

La imagen SÍ es apta (apta: true) si muestra situaciones normales de barrio aunque sean fuertes: accidentes de tránsito, calles inundadas, basura, daños, personas discutiendo, animales heridos, etc. Ante la duda razonable, marca apta: true.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mime, data: base64 } }
            ]
          }],
          generationConfig: { temperature: 0 }
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error('Error de Gemini:', data);
      // Si Gemini falla, dejamos pasar la foto para no bloquear la app
      // (la moderación comunitaria queda como respaldo)
      return res.status(200).json({ apta: true, razon: 'moderación no disponible' });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json|```/g, '').trim();

    let veredicto;
    try {
      veredicto = JSON.parse(limpio);
    } catch (e) {
      console.error('Gemini no respondió JSON válido:', texto);
      return res.status(200).json({ apta: true, razon: 'respuesta no interpretable' });
    }

    return res.status(200).json({
      apta: veredicto.apta !== false,
      razon: veredicto.razon || ''
    });
  } catch (e) {
    console.error('Error en moderar-foto:', e);
    // Falla abierta: ante un error técnico, no bloqueamos la publicación
    return res.status(200).json({ apta: true, razon: 'error técnico' });
  }
}
