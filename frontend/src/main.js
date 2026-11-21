import { flushSync, mount } from 'svelte';
import App from './App.svelte';

flushSync(() => mount(App, { target: document.getElementById('app') }));
document.getElementById('startup').remove();
