import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendWelcomeEmail } from './services/email.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

dotenv.config();

if (!process.env.JWT_SECRET) {
    console.warn('⚠️  WARNING: JWT_SECRET is not set in .env. Using insecure default — set a strong secret in production!');
}
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-antigravity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:5173', 'http://localhost:4173'];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json());

// Rate limiting for auth routes (10 attempts per 15 min per IP)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

// ==========================================
// PostgreSQL Database Setup
// ==========================================
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});



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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
    CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
    CREATE INDEX IF NOT EXISTS idx_clients_created_at ON clients(created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
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
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
            [name.trim(), email.toLowerCase().trim(), hashedPassword]
        );
        res.status(201).json({ message: 'User registered successfully', userId: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
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
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        const result = await pool.query(
            'SELECT * FROM clients ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );
        const total = await pool.query('SELECT COUNT(*) as count FROM clients');
        res.json({
            data: result.rows,
            total: Number(total.rows[0].count),
            page,
            limit
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leads', authenticateToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        const result = await pool.query(
            'SELECT * FROM leads ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );
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

app.get('/api/dashboard/monthly-stats', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as label,
                COUNT(*) as count
            FROM clients
            WHERE created_at >= NOW() - INTERVAL '6 months'
            GROUP BY DATE_TRUNC('month', created_at), label
            ORDER BY DATE_TRUNC('month', created_at)
        `);

        res.json({
            labels: result.rows.map(r => r.label),
            counts: result.rows.map(r => parseInt(r.count))
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

        // Trigger Make.com Webhook for manual entries (only if configured)
        const MAKE_WEBHOOK_URL = process.env.MAKE_CRM_WEBHOOK_URL;
        if (MAKE_WEBHOOK_URL) {
            fetch(MAKE_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: 'CRM_Manual',
                    ...newClient
                })
            }).catch(e => console.error('Make.com Webhook failed:', e.message));
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
             deal_value = COALESCE($12, deal_value),
             updated_at = NOW()
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
    // Tally webhook signature verification
    const TALLY_SECRET = process.env.TALLY_SIGNING_SECRET;
    if (TALLY_SECRET) {
        const signature = req.headers['tally-signature'];
        if (!signature) {
            return res.status(401).json({ status: 'error', error: 'Missing signature' });
        }
        const rawBody = JSON.stringify(req.body);
        const expected = crypto.createHmac('sha256', TALLY_SECRET).update(rawBody).digest('hex');
        if (signature !== expected) {
            return res.status(401).json({ status: 'error', error: 'Invalid signature' });
        }
    }

    console.log('--- Webhook Received ---');
    console.log('Timestamp:', new Date().toISOString());

    try {
        const body = req.body;
        const { data } = body;

        let clientData = {
            name: 'Unknown',
            email: '',
            company: '',
            phone: '',
            status: 'New'
        };

        if (data && data.fields) {
            // Native Tally webhook format
            data.fields.forEach(field => {
                const label = field.label || field.key || '';
                let value = field.value;

                // Multiple choice fields return array — take first item's text
                if (Array.isArray(value)) {
                    value = value.map(v => v.text || v).join(', ');
                }
                if (!value) return;

                if (label.includes('Име на Клиента') || label === 'Name') {
                    clientData.name = value;
                } else if (clientData.name === 'Unknown' && (label.includes('Name') || label.includes('Име'))) {
                    clientData.name = value;
                }
                if (label.includes('E-mail') || label.includes('Email') || label.includes('Поща') || label.includes('e-mail')) clientData.email = value;
                if (label.includes('Компания') || label.includes('Организация') || label.includes('Company') || label.includes('Фирма')) clientData.company = value;
                if (label.includes('Телефон') || label.includes('Phone')) clientData.phone = value;
                if (label.includes('списък с опции') || label.includes('Услуга') || label.includes('Service')) clientData.service_type = value;
                if (label.includes('Разкажи') || label.includes('повече') || label.includes('Note') || label.includes('Message') || label.includes('Описание') || label.includes('Бележк')) clientData.notes = value;
            });
        } else {
            // Flat format (Make.com HTTP module sends parsed fields directly)
            clientData.name = body.name || body['Име на Клиента'] || body.Name || 'Unknown';
            clientData.email = body.email || body['E-mail'] || body.Email || '';
            clientData.phone = body.phone || body['Телефон'] || body.Phone || '';
            clientData.company = body.company || body['Име на Компания / Организация'] || body.Company || '';
            clientData.service_type = body.service_type || body['Кратък списък с опции'] || '';
            clientData.notes = body.notes || body['Разкажи ми малко повече'] || '';
        }

        // Save to Database
        const result = await pool.query(
            'INSERT INTO clients (name, email, phone, company, status, notes, service_type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [clientData.name, clientData.email, clientData.phone, clientData.company, clientData.status, clientData.notes, clientData.service_type]
        );

        // Save structured data to leads table
        await pool.query(
            'INSERT INTO leads (source, data) VALUES ($1, $2)',
            ['Tally', JSON.stringify({
                name: clientData.name,
                email: clientData.email,
                phone: clientData.phone,
                company: clientData.company,
                service_type: clientData.service_type,
                notes: clientData.notes
            })]
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
