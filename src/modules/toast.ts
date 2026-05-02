export function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️',
        warning: '⚠️',
    };

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || 'ℹ️';

    const body = document.createElement('div');
    body.className = 'toast-message';
    body.textContent = message;

    const close = document.createElement('div');
    close.className = 'toast-close';
    close.textContent = '✕';

    toast.append(icon, body, close);

    container.appendChild(toast);

    const removeToast = () => {
        if (toast.parentElement) {
            toast.classList.add('removing');
            setTimeout(() => {
                if (toast.parentElement) container.removeChild(toast);
            }, 300);
        }
    };

    const timer = setTimeout(removeToast, duration);

    close.addEventListener('click', () => {
        clearTimeout(timer);
        removeToast();
    });
}
