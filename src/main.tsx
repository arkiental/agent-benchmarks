import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import '@fontsource-variable/archivo';
import './styles.css';
import { useResource } from './api';
import { Shell, Loading, EmptyState } from './components';
import { Journal, PostDetail, Compare } from './public';

const Admin = lazy(() => import('./admin'));
class Boundary extends React.Component<{ children: React.ReactNode },{ failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="page"><EmptyState title="This page could not load." body="Reload the page to try again."><button className="button" onClick={() => window.location.reload()}>Reload page</button></EmptyState></div> : this.props.children; }
}
function App() {
  const { data:site } = useResource<{ name: string }>('/api/site');
  return <BrowserRouter><Shell name={site?.name || 'Agent Benchmarks'}><Boundary><Suspense fallback={<div className="page"><Loading/></div>}><Routes><Route path="/" element={<Journal/>}/><Route path="/posts/:slug" element={<PostDetail/>}/><Route path="/compare" element={<Compare/>}/><Route path="/admin/*" element={<Admin/>}/><Route path="*" element={<div className="page"><EmptyState title="Page not found." body="This address may have changed."><Link to="/">Back to journal</Link></EmptyState></div>}/></Routes></Suspense></Boundary></Shell></BrowserRouter>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
