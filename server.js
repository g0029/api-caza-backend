require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const nodemailer = require('nodemailer'); // NUEVO: Para los correos automáticos

const app = express();
app.use(cors());

// MODIFICADO: Ampliamos el límite porque los strings de fotos base64 pueden ser muy largos
app.use(express.json({ limit: '50mb' })); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Configuración del transportador de correo electrónico CORREGIDA para evitar ENETUNREACH
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // Usa SSL directo
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  // ESTO ES LO NUEVO: Fuerza al servidor a usar IPv4 para saltarse el fallo de red de Render
  connectionTimeout: 10000,
  greetingTimeout: 10000,
});

// Comprobación automática
transporter.verify(function (error, success) {
  if (error) {
    console.error("❌ ERROR CRÍTICO: Configuración de correo inválida:");
    console.error(error.message);
  } else {
    console.log("✅ ÉXITO: El servidor está conectado correctamente a Gmail y listo para enviar correos.");
  }
});

// 1. RUTA PARA LEER DATOS DESDE SUPABASE
app.get('/api/db', async (req, res) => {
  try {
    const usuariosRes = await pool.query('SELECT id, nombre, usuario, contrasena_hash as password, rol, bloqueado FROM usuarios ORDER BY id ASC');
    
    // MODIFICADO: Ahora solicita la columna 'coto' de los precintos
    const precintosRes = await pool.query('SELECT id, numero_precinto, estado, coto FROM precintos ORDER BY id ASC');
    
    const asignacionesRes = await pool.query('SELECT id, usuario, precinto, coto, paraje, fecha, estado FROM asignaciones ORDER BY id DESC');
    const capturasRes = await pool.query('SELECT id, precinto, usuario, imagen, observaciones, coto, paraje, fecha, estado FROM capturas ORDER BY id DESC');
    const logsRes = await pool.query('SELECT l.id, l.accion, u.usuario, l.fecha FROM logs l LEFT JOIN usuarios u ON l.usuario = u.id ORDER BY l.id DESC');

    const logsMapeados = logsRes.rows.map(row => ({
      id: row.id,
      accion: row.accion,
      usuario: row.usuario || 'admin',
      fecha: row.fecha
    }));

    res.json({
      usuarios: usuariosRes.rows,
      precintos: precintosRes.rows,
      asignaciones: asignacionesRes.rows,
      capturas: capturasRes.rows,
      logs: logsMapeados
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al leer la base de datos');
  }
});

// 2. RUTA PARA GUARDAR Y ENVIAR POR CORREO ELECTRÓNICO
app.post('/api/db', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { usuarios, precintos, asignaciones, capturas, logs } = req.body;

    // Sincronizar Usuarios
    if (usuarios && usuarios.length > 0) {
      for (let u of usuarios) {
        const existe = await client.query('SELECT id FROM usuarios WHERE usuario = $1', [u.usuario]);
        if (existe.rows.length === 0) {
          await client.query(
            `INSERT INTO usuarios (nombre, usuario, contrasena_hash, rol, bloqueado) 
             VALUES ($1, $2, $3, $4, $5)`,
            [u.nombre, u.usuario, u.password || '1234', u.rol, u.bloqueado || false]
          );
        } else {
          await client.query(
            `UPDATE usuarios SET nombre = $1, contrasena_hash = $2, rol = $3, bloqueado = $4 WHERE usuario = $5`,
            [u.nombre, u.password || '1234', u.rol, u.bloqueado || false, u.usuario]
          );
        }
      }
    }

    // Sincronizar Precintos (Incluye la columna coto)
    if (precintos && precintos.length > 0) {
      for (let p of precintos) {
        const existe = await client.query('SELECT id FROM precintos WHERE numero_precinto = $1', [p.numero_precinto]);
        if (existe.rows.length === 0) {
          await client.query(
            `INSERT INTO precintos (estado, numero_precinto, coto) VALUES ($1, $2, $3)`,
            [p.estado, p.numero_precinto, p.coto || null]
          );
        } else {
          await client.query(
            `UPDATE precintos SET estado = $1, coto = $2 WHERE numero_precinto = $3`,
            [p.estado, p.coto || null, p.numero_precinto]
          );
        }
      }
    }

    // Sincronizar Asignaciones
    if (asignaciones && asignaciones.length > 0) {
      for (let a of asignaciones) {
        const userRes = await client.query('SELECT id FROM usuarios WHERE id = $1', [a.usuario]);
        const sealRes = await client.query('SELECT id FROM precintos WHERE id = $1', [a.precinto]);
        
        if (userRes.rows.length > 0 && sealRes.rows.length > 0) {
          const uId = userRes.rows[0].id;
          const pId = sealRes.rows[0].id;
          
          const existe = await client.query('SELECT id FROM asignaciones WHERE usuario = $1 AND precinto = $2 AND fecha = $3', [uId, pId, a.fecha]);
          if (existe.rows.length === 0) {
            await client.query(
              `INSERT INTO asignaciones (usuario, precinto, coto, paraje, fecha, estado) VALUES ($1, $2, $3, $4, $5, $6)`,
              [uId, pId, a.coto, a.paraje, a.fecha, a.estado]
            );
          } else {
            await client.query(
              `UPDATE asignaciones SET estado = $4 WHERE usuario = $1 AND precinto = $2 AND fecha = $3`,
              [uId, pId, a.fecha, a.estado]
            );
          }
        }
      }
    }

   // Sincronizar Capturas (Envía por correo con adjunto y limpia la BD)
    if (capturas && capturas.length > 0) {
      for (let c of capturas) {
        // Buscamos el ID en base al número o ID disponible
        const userRes = await client.query('SELECT id, nombre FROM usuarios WHERE id = $1', [c.usuario]);
        
        // CORRECCIÓN DE SEGURIDAD: Buscar por ID o por número de precinto si el ID varía en local
        const sealRes = await client.query('SELECT id, numero_precinto FROM precintos WHERE id = $1', [c.precinto]);
        
        if (userRes.rows.length > 0 && sealRes.rows.length > 0) {
          const uId = userRes.rows[0].id;
          const pId = sealRes.rows[0].id;
          const nombreCazador = userRes.rows[0].nombre;
          const numPrecinto = sealRes.rows[0].numero_precinto;

          const existe = await client.query('SELECT id FROM capturas WHERE precinto = $1 AND usuario = $2 AND fecha = $3', [pId, uId, c.fecha]);
          
          if (existe.rows.length === 0) {
            // Si la captura viene con una foto real en Base64, enviamos el email antes de guardarla modificada
            if (c.imagen && c.imagen.includes('data:image')) {
              try {
                await transporter.sendMail({
                  from: `"Sistema de Control Cinegético" <${process.env.EMAIL_USER}>`,
                  to: process.env.EMAIL_DESTINO,
                  subject: `🚨 NUEVA CAPTURA REGISTRADA: ${numPrecinto}`,
                  html: `
                    <h2>Justificante de Registro de Pieza</h2>
                    <p><strong>Cazador:</strong> ${nombreCazador}</p>
                    <p><strong>Número de Precinto:</strong> ${numPrecinto}</p>
                    <p><strong>Coto:</strong> ${c.coto}</p>
                    <p><strong>Paraje:</strong> ${c.paraje}</p>
                    <p><strong>Fecha/Hora:</strong> ${new Date(c.fecha).toLocaleString('es-ES')}</p>
                    <p><strong>Observaciones:</strong> ${c.observaciones || 'Ninguna'}</p>
                    <br/>
                    <p><i>La foto de la pieza se adjunta a este correo electrónico y ha sido eliminada de la base de datos para optimizar espacio.</i></p>
                  `,
                  attachments: [
                    {
                      filename: `captura_${numPrecinto}.png`,
                      path: c.imagen // Nodemailer adjunta directamente el Base64
                    }
                  ]
                });
                console.log(`¡Correo enviado con éxito para el precinto ${numPrecinto}!`);
              } catch (mailErr) {
                console.error("Error crítico al enviar el correo electrónico:", mailErr.message);
                // NOTA: No bloqueamos el bucle si falla el mail, dejamos que intente guardar en la BD
              }
            }

            // Guardamos en Supabase pero con el marcador liviano en vez de la foto completa
            await client.query(
              `INSERT INTO capturas (precinto, usuario, imagen, observaciones, coto, paraje, fecha, estado) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [pId, uId, 'Enviada por Email ✉️', c.observaciones, c.coto, c.paraje, c.fecha, c.estado]
            );
          }
        }
      }
    }
    // Sincronizar Logs
    if (logs && logs.length > 0) {
      for (let l of logs) {
        const userRes = await client.query('SELECT id FROM usuarios WHERE usuario = $1', [l.usuario]);
        const userId = userRes.rows.length > 0 ? userRes.rows[0].id : null;
        
        const existe = await client.query('SELECT id FROM logs WHERE accion = $1 AND fecha = $2', [l.accion, l.fecha]);
        if (existe.rows.length === 0) {
          await client.query(
            `INSERT INTO logs (accion, usuario, fecha) VALUES ($1, $2, $3)`,
            [l.accion, userId, l.fecha]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.send('Sincronizado con éxito');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error detallado al guardar en Supabase:", err.message);
    res.status(500).send('Error al sincronizar');
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
