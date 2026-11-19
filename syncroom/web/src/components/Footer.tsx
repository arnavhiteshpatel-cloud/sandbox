import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="mt-16 border-t border-white/5 px-4 sm:px-10 py-10 text-xs text-haze-500 leading-relaxed">
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 text-haze-400">
        <Link to="/free">Watch free now</Link><Link to="/rooms">Rooms</Link><Link to="/library">My list</Link><Link to="/settings">Sources & settings</Link>
      </div>
      <p>SyncRoom contains no advertising. Catalogue metadata is provided by Cinemeta (IMDb-keyed) or TMDB when configured; a title appearing in the catalogue does not mean it is playable — only titles marked <span className="text-ok">WATCH</span> have a verified source.</p>
      <p className="mt-1">Playable sources: your own media, your Jellyfin/Plex servers, links you add, Blender Foundation open movies (CC BY) and public-domain works from the Internet Archive.</p>
    </footer>
  );
}
