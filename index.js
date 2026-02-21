import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendWelcomeEmail } from './services/email.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-antigravity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// PostgreSQL Database Setup
// ==========================================
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Thin adapter: makes pool work like the old SQLite db.run/db.get/db.all
const db = {
    async run(sql, params = []) {
        const pgSql = sqliteToPostgres(sql, params);
        const result = await pool.query(pgSql.text, pgSql.values);
        return { lastID: result.rows[0]?.id, changes: result.rowCount };
    },
    async get(sql, params = []) {
        const pgSql = sqliteToPostgres(sql, params);
        const result = await pool.query(pgSql.text, pgSql.values);
        return result.rows[0] || null;
    },
    async all(sql, params = []) {
        const pgSql = sqliteToPostgres(sql, params);
        const result = await pool.query(pgSql.text, pgSql.values);
        return result.rows;
    }
};

// Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
function sqliteToPostgres(sql, params = []) {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    return { text, values: params };
}

async function initializeDB() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      service_type TEXT,
      social_platform TEXT,
      preferred_contact TEXT,
      notes TEXT,
      lost_reason TEXT,
      meeting_date TIMESTAMP,
      deal_value REAL,
      status TEXT DEFAULT 'New',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      source TEXT,
      data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

    console.log('PostgreSQL database connected and initialized');
}

initializeDB().catch(err => {
    console.error('Database initialization failed:', err);
});

// Routes
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'CRM Server is running' });
});

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
            [name, email, hashedPassword]
        );
        res.status(201).json({ message: 'User registered successfully', userId: result.rows[0].id });
    } catch (err) {
        if (err.message.includes('unique') || err.message.includes('duplicate')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.get('/api/clients', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leads', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
        res.json(result.rows.map(l => ({ ...l, data: JSON.parse(l.data) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        const totalClients = await pool.query('SELECT COUNT(*) as count FROM clients');
        const totalLeads = await pool.query('SELECT COUNT(*) as count FROM leads');
        const newClients = await pool.query("SELECT COUNT(*) as count FROM clients WHERE status = 'New'");

        const meetings = await pool.query("SELECT meeting_date FROM clients WHERE meeting_date IS NOT NULL AND meeting_date > NOW() - INTERVAL '30 days'");

        res.json({
            totalClients: parseInt(totalClients.rows[0].count),
            totalLeads: parseInt(totalLeads.rows[0].count),
            newClients: parseInt(newClients.rows[0].count),
            meetingsCount: meetings.rows.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clients', authenticateToken, async (req, res) => {
    const { name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, meeting_date, deal_value } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO clients (name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, meeting_date, deal_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
            [name, email, phone, company, status || 'New', service_type, social_platform, preferred_contact, notes, meeting_date, deal_value]
        );
        const newClient = { id: result.rows[0].id, ...req.body };

        // Trigger Make.com Webhook for manual entries
        const MAKE_WEBHOOK_URL = process.env.MAKE_CRM_WEBHOOK_URL || 'https://hook.eu2.make.com/08lc63392kl4l1d9jrajjof7t2hpph8t';
        try {
            fetch(MAKE_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: 'CRM_Manual',
                    ...newClient
                })
            }).catch(e => console.error('Make.com Webhook failed:', e.message));
        } catch (e) {
            console.error('Webhook fetch error:', e.message);
        }

        res.status(201).json(newClient);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, lost_reason, meeting_date, deal_value } = req.body;

    try {
        await pool.query(
            `UPDATE clients SET 
             name = COALESCE($1, name), 
             email = COALESCE($2, email), 
             phone = COALESCE($3, phone), 
             company = COALESCE($4, company), 
             status = COALESCE($5, status),
             service_type = COALESCE($6, service_type),
             social_platform = COALESCE($7, social_platform),
             preferred_contact = COALESCE($8, preferred_contact),
             notes = COALESCE($9, notes),
             lost_reason = COALESCE($10, lost_reason),
             meeting_date = COALESCE($11, meeting_date),
             deal_value = COALESCE($12, deal_value)
             WHERE id = $13`,
            [name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, lost_reason, meeting_date, deal_value, id]
        );
        res.json({ message: 'Client updated successfully', id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Webhook for Tally Forms
app.post('/api/webhook', async (req, res) => {
    console.log('--- Webhook Received ---');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));

    try {
        const { data, eventId, createdAt } = req.body;

        let clientData = {
            name: 'Unknown',
            email: '',
            company: '',
            phone: '',
            status: 'New'
        };

        if (data && data.fields) {
            data.fields.forEach(field => {
                const label = field.label || field.key;
                const value = field.value;

                if (!value) return;

                if (label.includes('Име на Клиента') || label === 'Name') {
                    clientData.name = value;
                } else if (!clientData.name || clientData.name === 'Unknown') {
                    if (label.includes('Name') || label.includes('Име')) clientData.name = value;
                }

                if (label.includes('Email') || label.includes('E-mail') || label.includes('Поща') || label.includes('e-mail')) clientData.email = value;
                if (label.includes('Company') || label.includes('Фирма') || label.includes('Организация') || label.includes('Компания')) clientData.company = value;
                if (label.includes('Phone') || label.includes('Телефон')) clientData.phone = value;
                if (label.includes('списък с опции') || label.includes('Услуга') || label.includes('Service')) clientData.service_type = value;
                if (label.includes('Разкажи') || label.includes('повече') || label.includes('Note') || label.includes('Message') || label.includes('Описание') || label.includes('Бележк')) clientData.notes = value;
            });
        }

        // Save to Database
        const result = await pool.query(
            'INSERT INTO clients (name, email, phone, company, status, notes, service_type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [clientData.name, clientData.email, clientData.phone, clientData.company, clientData.status, clientData.notes, clientData.service_type]
        );

        // Also log to leads table
        await pool.query(
            'INSERT INTO leads (source, data) VALUES ($1, $2)',
            ['Tally', JSON.stringify(req.body)]
        );

        console.log(`New lead created from Webhook: ${clientData.name}`);

        if (clientData.email) {
            console.log(`Attempting to send email to ${clientData.email}...`);
            const serviceType = clientData.notes && clientData.notes.length < 50 ? clientData.notes : 'Professional Services';
            sendWelcomeEmail(clientData.email, clientData.name, serviceType).catch(err => console.error('Email fail:', err));
        }

        res.status(200).json({ status: 'success', id: result.rows[0].id });

    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// Delete client
app.delete('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM clients WHERE id = $1', [id]);
        res.json({ message: 'Client deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
