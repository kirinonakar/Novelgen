import { els } from './dom_refs.js';

export function initSidebarResizer() {
    const resizer = els.resizer;
    const sidebar = els.sidebar;
    if (!resizer || !sidebar) return;

    const savedWidth = localStorage.getItem('sidebar-width');
    if (savedWidth && !isNaN(parseInt(savedWidth))) {
        sidebar.style.width = savedWidth + 'px';
    }

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('is-resizing');
        resizer.classList.add('dragging');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        let newWidth = e.clientX;
        if (newWidth < 250) newWidth = 250;
        if (newWidth > 600) newWidth = 600;

        sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        document.body.style.cursor = 'default';
        document.body.classList.remove('is-resizing');
        resizer.classList.remove('dragging');

        const currentWidth = parseInt(sidebar.style.width) || sidebar.offsetWidth;
        localStorage.setItem('sidebar-width', currentWidth);
    });
}
