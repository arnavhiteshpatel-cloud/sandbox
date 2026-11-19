import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import Home from './pages/Home';
import { Spinner } from './components/ui';

const Browse = lazy(() => import('./pages/Browse'));
const Search = lazy(() => import('./pages/Search'));
const Title = lazy(() => import('./pages/Title'));
const Watch = lazy(() => import('./pages/Watch'));
const Room = lazy(() => import('./pages/Room'));
const Library = lazy(() => import('./pages/Library'));
const Free = lazy(() => import('./pages/Free'));
const Settings = lazy(() => import('./pages/Settings'));
const Rooms = lazy(() => import('./pages/Rooms'));

export default function App() {
  const loc = useLocation();
  const immersive = loc.pathname.startsWith('/watch') || loc.pathname.startsWith('/room/');
  useEffect(() => { if (!immersive) window.scrollTo({ top: 0 }); }, [loc.pathname, immersive]);
  return (
    <div className="min-h-screen flex flex-col">
      {!immersive && <Navbar />}
      <main className="flex-1">
        <ErrorBoundary key={loc.pathname}>
        <Suspense fallback={<div className="h-[70vh] grid place-items-center"><Spinner /></div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/browse/:type" element={<Browse />} />
            <Route path="/search" element={<Search />} />
            <Route path="/title/:type/:id" element={<Title />} />
            <Route path="/watch/:type/:id" element={<Watch />} />
            <Route path="/watch/:type/:id/:season/:episode" element={<Watch />} />
            <Route path="/room/:roomId" element={<Room />} />
            <Route path="/rooms" element={<Rooms />} />
            <Route path="/library" element={<Library />} />
            <Route path="/free" element={<Free />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<div className="h-[60vh] grid place-items-center text-haze-300">Page not found.</div>} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
      {!immersive && <Footer />}
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[ui]', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-[70vh] grid place-items-center p-6 text-center">
        <div>
          <div className="font-display text-3xl mb-2">Something went wrong</div>
          <p className="text-haze-400 mb-6 max-w-md">{this.state.error.message}</p>
          <button className="btn-primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
