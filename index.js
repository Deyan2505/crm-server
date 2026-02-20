import express from 'express';
import cors from 'cors';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
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

// Database Setup
let db;
async function initializeDB() {
    db = await open({
        filename: path.join(__dirname, 'crm.db'),
        driver: sqlite3.Database
    });

    // Create tables if they don't exist
    await db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      service_type TEXT,
      social_platform TEXT,
      preferred_contact TEXT,
      notes TEXT,
      lost_reason TEXT,
      meeting_date DATETIME,
      deal_value REAL,
      status TEXT DEFAULT 'New',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

    console.log('Database connected and initialized');
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
        const result = await db.run(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );
        res.status(201).json({ message: 'User registered successfully', userId: result.lastID });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
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
        const clients = await db.all('SELECT * FROM clients ORDER BY created_at DESC');
        res.json(clients);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leads', authenticateToken, async (req, res) => {
    try {
        const leads = await db.all('SELECT * FROM leads ORDER BY created_at DESC');
        res.json(leads.map(l => ({ ...l, data: JSON.parse(l.data) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const users = await db.all('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        const totalClients = await db.get('SELECT COUNT(*) as count FROM clients');
        const totalLeads = await db.get('SELECT COUNT(*) as count FROM leads');
        const newClients = await db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'New'");

        // Mock data for chart - in a real app this would be an aggregation query
        const meetings = await db.all("SELECT meeting_date FROM clients WHERE meeting_date IS NOT NULL AND meeting_date > datetime('now', '-30 days')");

        res.json({
            totalClients: totalClients.count,
            totalLeads: totalLeads.count,
            newClients: newClients.count,
            meetingsCount: meetings.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clients', authenticateToken, async (req, res) => {
    const { name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, meeting_date, deal_value } = req.body;
    try {
        const result = await db.run(
            'INSERT INTO clients (name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, meeting_date, deal_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email, phone, company, status || 'New', service_type, social_platform, preferred_contact, notes, meeting_date, deal_value]
        );
        res.status(201).json({ id: result.lastID, ...req.body });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { name, email, phone, company, status, service_type, social_platform, preferred_contact, notes, lost_reason, meeting_date, deal_value } = req.body;

    try {
        await db.run(
            `UPDATE clients SET 
             name = COALESCE(?, name), 
             email = COALESCE(?, email), 
             phone = COALESCE(?, phone), 
             company = COALESCE(?, company), 
             status = COALESCE(?, status),
             service_type = COALESCE(?, service_type),
             social_platform = COALESCE(?, social_platform),
             preferred_contact = COALESCE(?, preferred_contact),
             notes = COALESCE(?, notes),
             lost_reason = COALESCE(?, lost_reason),
             meeting_date = COALESCE(?, meeting_date),
             deal_value = COALESCE(?, deal_value)
             WHERE id = ?`,
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

        // Tally sends an array of fields. We need to parse them.
        // Assuming fields like: "Name", "Email", "Company", etc.
        // Example: { label: "Name", value: "John Doe" }

        let clientData = {
            name: 'Unknown',
            email: '',
            company: '',
            phone: '',
            status: 'Inquiry' // New leads come as 'Inquiry'
        };

        // Helper to find value by label (case insensitive approach recommended)
        if (data && data.fields) {
            data.fields.forEach(field => {
                const label = field.label || field.key; // Tally uses label or key
                const value = field.value;

                if (!value) return;

                // Client name — match "Име на Клиента" but NOT generic "Име на..." fields
                if (label.includes('Име на Клиента') || label === 'Name') {
                    clientData.name = value;
                } else if (!clientData.name || clientData.name === 'Unknown') {
                    // Fallback: any field containing "Name" or "Име" (only if name not already set)
                    if (label.includes('Name') || label.includes('Име')) clientData.name = value;
                }

                // Email — handle both "Email" and "E-mail" (with hyphen)
                if (label.includes('Email') || label.includes('E-mail') || label.includes('Поща') || label.includes('e-mail')) clientData.email = value;

                // Company
                if (label.includes('Company') || label.includes('Фирма') || label.includes('Организация') || label.includes('Компания')) clientData.company = value;

                // Phone
                if (label.includes('Phone') || label.includes('Телефон')) clientData.phone = value;

                // Service type — "Кратък списък с опции" from the Tally form
                if (label.includes('списък с опции') || label.includes('Услуга') || label.includes('Service')) clientData.service_type = value;

                // Notes — "Разкажи ми малко повече" from the Tally form
                if (label.includes('Разкажи') || label.includes('повече') || label.includes('Note') || label.includes('Message') || label.includes('Описание') || label.includes('Бележк')) clientData.notes = value;
            });
        }

        // Save to Database
        const result = await db.run(
            'INSERT INTO clients (name, email, phone, company, status, notes, service_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [clientData.name, clientData.email, clientData.phone, clientData.company, clientData.status, clientData.notes, clientData.service_type]
        );

        // Also log to leads table for full record
        await db.run(
            'INSERT INTO leads (source, data) VALUES (?, ?)',
            ['Tally', JSON.stringify(req.body)]
        );

        console.log(`New lead created from Webhook: ${clientData.name}`);

        // Send Automatic Email with Smart Response
        if (clientData.email) {
            console.log(`Attempting to send email to ${clientData.email}...`);
            const serviceType = clientData.notes && clientData.notes.length < 50 ? clientData.notes : 'Professional Services';
            sendWelcomeEmail(clientData.email, clientData.name, serviceType).catch(err => console.error('Email fail:', err));
        }

        res.status(200).json({ status: 'success', id: result.lastID });

    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// Delete client
app.delete('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await db.run('DELETE FROM clients WHERE id = ?', [id]);
        res.json({ message: 'Client deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => {

    console.log(`Server running on http://localhost:${PORT}`);
});
