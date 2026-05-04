import React from 'react';
import { NavLink, Link } from 'react-router-dom';
import { LayoutDashboard, Users, Mail, Settings, ArrowLeft } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';

const Sidebar = () => {
    const { t } = useLanguage();
    const { user } = useAuth();

    const navItems = [
        { icon: <LayoutDashboard size={20} />, label: t('dashboard'), path: '/app', end: true },
        { icon: <Users size={20} />, label: t('clients'), path: '/app/clients' },
        { icon: <Mail size={20} />, label: t('leads'), path: '/app/leads' },
        { icon: <Settings size={20} />, label: t('settings'), path: '/app/settings' },
    ];

    const initials = user?.name
        ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
        : 'U';

    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <div className="logo-icon">CRM</div>
                <span className="logo-text">Universal CRM</span>
            </div>

            <nav className="sidebar-nav">
                {navItems.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.end}
                        className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    >
                        {item.icon}
                        <span>{item.label}</span>
                    </NavLink>
                ))}
            </nav>

            <div className="sidebar-footer">
                <Link to="/" className="sidebar-back-link">
                    <ArrowLeft size={16} />
                    <span>Към сайта</span>
                </Link>
                <div className="user-info">
                    <div className="avatar">{initials}</div>
                    <div className="user-details">
                        <span className="user-name">{user?.name || 'User'}</span>
                        <span className="user-role">Admin</span>
                    </div>
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;
