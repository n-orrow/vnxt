// Copy to clipboard functionality
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;

        btn.textContent = 'Copied!';
        btn.style.background = '#52d457';

        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

// Set header height CSS variable
function updateHeaderHeight() {
    const header = document.querySelector('header');
    if (header) {
        document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
    }
}

updateHeaderHeight();
window.addEventListener('resize', updateHeaderHeight);

// Tab switching functionality
function switchTab(el, tabId) {
    const tabsContainer = el.closest('.tabs');

    tabsContainer.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.getElementById(tabId).classList.add('active');
    el.classList.add('active');
}

// Shrinking header on scroll
let lastScroll = 0;
const header = document.querySelector('header');

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    if (currentScroll > 0) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }

    lastScroll = currentScroll;
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (!href || href === '#') return;
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

// Active nav link on scroll
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('href') === `#${entry.target.id}`) {
                    link.classList.add('active');
                }
            });
        }
    });
}, {
    rootMargin: '-20% 0px -70% 0px'
});

sections.forEach(section => observer.observe(section));
// Releases drawer
const drawer        = document.getElementById('releases-drawer');
const overlay       = document.getElementById('drawer-overlay');
const trigger       = document.getElementById('releases-trigger');
const closeBtn      = document.getElementById('drawer-close');
const releasesList  = document.getElementById('releases-list');
let releasesLoaded  = false;

function openDrawer() {
    drawer.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    if (!releasesLoaded) loadReleases();
}

function closeDrawer() {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

trigger.addEventListener('click', (e) => {
    e.preventDefault();
    openDrawer();
});

closeBtn.addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
});

async function loadReleases() {
    try {
        const response = await fetch('https://api.github.com/repos/n-orrow/vnxt/contents/release-notes');
        if (!response.ok) throw new Error('Failed to fetch releases');

        const files = await response.json();

        const mdFiles = files
            .filter(f => f.name.endsWith('.md'))
            .sort((a, b) => b.name.localeCompare(a.name));

        if (mdFiles.length === 0) {
            releasesList.innerHTML = '<p class="loading">No releases yet.</p>';
            return;
        }

        const releases = await Promise.all(mdFiles.map(async file => {
            const res  = await fetch(file.download_url);
            const text = await res.text();
            return { name: file.name, content: text };
        }));

        releasesList.innerHTML = releases.map(release => {
            const lines      = release.content.split('\n');
            const title      = lines[0].replace('# ', '');
            const metaLine   = lines.find(l => l.startsWith('Released:')) || '';
            const authorLine = lines.find(l => l.startsWith('Author:'))   || '';

            const changesIdx = lines.findIndex(l => l === '## Changes');
            const notesIdx   = lines.findIndex(l => l === '## Release Notes');
            const installIdx = lines.findIndex(l => l === '## Installation');

            const changes = changesIdx !== -1
                ? lines.slice(changesIdx + 1, notesIdx !== -1 ? notesIdx : installIdx).join('\n').trim()
                : '';

            const notes = notesIdx !== -1
                ? lines.slice(notesIdx + 1, installIdx !== -1 ? installIdx : undefined).join('\n').trim()
                : '';

            const installCmd = lines.find(l => l.startsWith('npm install')) || '';

            return `
            <div class="release-card">
                <div class="release-header">
                    <h3>${title}</h3>
                    <div class="release-meta">
                        ${metaLine   ? `<span>${metaLine}</span>`   : ''}
                        ${authorLine ? `<span>${authorLine}</span>` : ''}
                    </div>
                </div>
                ${changes ? `
                <div class="release-section">
                    <h4>Changes</h4>
                    <p>${changes}</p>
                </div>` : ''}
                ${notes ? `
                <div class="release-section">
                    <h4>Release Notes</h4>
                    <p>${notes}</p>
                </div>` : ''}
                ${installCmd ? `
                <div class="release-install">
                    <span class="prompt">${installCmd}</span>
                    <button class="copy-btn" onclick="copyToClipboard('${installCmd}')">Copy</button>
                </div>` : ''}
            </div>`;
        }).join('');

        releasesLoaded = true;

    } catch (err) {
        releasesList.innerHTML = `<p class="loading">Could not load releases. <a href="https://github.com/n-orrow/vnxt/tree/main/release-notes" target="_blank">View on GitHub</a></p>`;
    }
}