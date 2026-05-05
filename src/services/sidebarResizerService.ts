interface SidebarResizerElements {
    resizer: HTMLElement;
    sidebar: HTMLElement;
}

const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-width';

export function installSidebarResizer({ resizer, sidebar }: SidebarResizerElements) {
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (savedWidth && !Number.isNaN(parseInt(savedWidth, 10))) {
        sidebar.style.width = `${savedWidth}px`;
    }

    let isResizing = false;

    const onMouseDown = (event: MouseEvent) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('is-resizing');
        resizer.classList.add('dragging');
        event.preventDefault();
    };

    const onMouseMove = (event: MouseEvent) => {
        if (!isResizing) return;

        let newWidth = event.clientX;
        if (newWidth < 250) newWidth = 250;
        if (newWidth > 600) newWidth = 600;

        sidebar.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
        if (!isResizing) return;
        isResizing = false;
        document.body.style.cursor = 'default';
        document.body.classList.remove('is-resizing');
        resizer.classList.remove('dragging');

        const currentWidth = parseInt(sidebar.style.width, 10) || sidebar.offsetWidth;
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(currentWidth));
    };

    resizer.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
        resizer.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'default';
        document.body.classList.remove('is-resizing');
        resizer.classList.remove('dragging');
    };
}
