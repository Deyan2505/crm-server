import nodemailer from 'nodemailer';

// Create a transporter using Gmail (or generic SMTP)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'your-email@gmail.com', // Replace with environment variable later
        pass: process.env.EMAIL_PASS || 'your-app-password'     // Replace with App Password
    }
});

export const sendWelcomeEmail = async (clientEmail, clientName, serviceType) => {
    if (!clientEmail) return;

    // AI Logic Placeholder: In a real scenario, this would call OpenAI API
    const aiGeneratedDetails = getSmartResponse(serviceType);

    const mailOptions = {
        from: '"Universal CRM" <noreply@crm.com>',
        to: clientEmail,
        subject: `Regarding your inquiry: ${serviceType || 'Services'}`,
        html: `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; line-height: 1.6;">
        <h2 style="color: #6366f1;">Hello ${clientName},</h2>
        
        <p>Thank you for reaching out about <strong>${serviceType || 'our services'}</strong>.</p>
        
        <p>${aiGeneratedDetails}</p>

        <p>To move forward, I would love to schedule a quick call to discuss your specific needs.</p>
        
        <div style="margin: 20px 0;">
            <a href="https://calendly.com/your-calendar-link" style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                📅 Schedule a Meeting
            </a>
        </div>

        <p>Alternatively, feel free to reply to this email.</p>
        <br>
        <p>Best regards,</p>
        <p><strong>The Universal CRM Team</strong></p>
      </div>
    `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
};

function getSmartResponse(serviceType) {
    // Simple rule-based "AI" for now
    if (!serviceType) return "We specialize in providing top-tier solutions for businesses of all sizes.";

    const lower = serviceType.toLowerCase();

    if (lower.includes('web') || lower.includes('design') || lower.includes('site')) {
        return "I see you're interested in digital presence. Our team creates stunning, high-performance websites that drive conversion. We can help you build a site that not only looks great but also works for your business.";
    }

    if (lower.includes('consult') || lower.includes('advise')) {
        return "Expert advice is crucial for growth. Our consultation services are designed to identify bottlenecks and unlock new opportunities for your company.";
    }

    if (lower.includes('marketing') || lower.includes('seo')) {
        return "Visibility is key. We have a proven track record of improving reach and engagement through targeted marketing strategies.";
    }

    return "We are excited to hear more about your project and see how we can deliver value to your business.";
}
