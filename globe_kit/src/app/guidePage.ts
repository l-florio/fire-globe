import { mountAppBar } from './appBar';
import { applyI18n, t, type Key } from './i18n';
import './tablePage.css';
import './aboutPage.css';

// Quick start page (guide.html): the six steps that show the main use of the app. Same layout as the About page.
mountAppBar({ current: 'guide' });
applyI18n();
document.title = `Fire Globe - ${t('about.start.h')}`;

const steps = Array.from({ length: 6 }, (_, i) => `<li>${t(`about.start.${i + 1}` as Key)}</li>`).join('');
document.getElementById('about-main')!.innerHTML = `
  <h1>${t('about.start.h')}</h1>
  <section><ol class="guide-steps">${steps}</ol></section>`;
