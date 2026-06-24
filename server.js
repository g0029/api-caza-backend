require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 1. RUTA PARA LEER DATOS DESDE SUPABASE
app.get('/api/db', async (req, res) => {
  try {
    const usuariosRes = await pool.query('SELECT id, nombre, usuario, contrasena_hash as password, rol, bloqueado FROM usuarios ORDER BY id ASC');
    const precintosRes = await pool.query('SELECT id, numero_precinto, estado FROM precintos ORDER BY id ASC');
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
    console.error("Error al leer de Supabase:", err.message);
    res.status(500).send('Error al leer las tablas');
  }
});

// 2. RUTA PARA GUARDAR Y RELLENAR TABLAS AUTOMÁTICAMENTE (CORREGIDA)
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

    // Sincronizar Precintos
    if (precintos && precintos.length > 0) {
      for (let p of precintos) {
        const existe = await client.query('SELECT id FROM precintos WHERE numero_precinto = $1', [p.numero_precinto]);
        if (existe.rows.length === 0) {
          await client.query(
            `INSERT INTO precintos (numero_precinto, estado) VALUES ($1, $2)`,
            [p.numero_precinto, p.estado]
          );
        } else {
          await client.query(
            `UPDATE precintos SET estado = $2 WHERE numero_precinto = $1`,
            [p.numero_precinto, p.estado]
          );
        }
      }
    }

    // Sincronizar Asignaciones (Corregido para buscar IDs reales de Supabase)
    if (asignaciones && asignaciones.length > 0) {
      for (let a of asignaciones) {
        // Encontramos los datos en texto que envió el frontend
        const usuarioObjeto = usuarios.find(u => u.id === a.usuario);
        const precintoObjeto = precintos.find(p => p.id === a.precinto);

        if (usuarioObjeto && precintoObjeto) {
          // Buscamos cuál es el ID real en Supabase para ese usuario y ese número de precinto
          const userRes = await client.query('SELECT id FROM usuarios WHERE usuario = $1', [usuarioObjeto.usuario]);
          const sealRes = await client.query('SELECT id FROM precintos WHERE numero_precinto = $1', [precintoObjeto.numero_precinto]);
          
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
    }

    // Sincronizar Capturas (Corregido para buscar IDs reales de Supabase)
    if (capturas && capturas.length > 0) {
      for (let c of capturas) {
        const usuarioObjeto = usuarios.find(u => u.id === c.usuario);
        const precintoObjeto = precintos.find(p => p.id === c.precinto);

        if (usuarioObjeto && precintoObjeto) {
          const userRes = await client.query('SELECT id FROM usuarios WHERE usuario = $1', [usuarioObjeto.usuario]);
          const sealRes = await client.query('SELECT id FROM precintos WHERE numero_precinto = $1', [precintoObjeto.numero_precinto]);
          
          if (userRes.rows.length > 0 && sealRes.rows.length > 0) {
            const uId = userRes.rows[0].id;
            const pId = sealRes.rows[0].id;

            const existe = await client.query('SELECT id FROM capturas WHERE precinto = $1 AND usuario = $2 AND fecha = $3', [pId, uId, c.fecha]);
            if (existe.rows.length === 0) {
              await client.query(
                `INSERT INTO capturas (precinto, usuario, imagen, observaciones, coto, paraje, fecha, estado) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [pId, uId, c.imagen || '', c.observaciones, c.coto, c.paraje, c.fecha, c.estado]
              );
            }
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
app.get('/', (req, res) => {
  res.send('Servidor API activo y conectado de forma estricta a Supabase.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor API corriendo en el puerto ${PORT}`);
});
