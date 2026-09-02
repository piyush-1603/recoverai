'use client';

import { useRef, useEffect, useState, Component, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type * as THREE from 'three';

// Fallback Error Boundary to ensure graceful degradation if WebGL is unavailable
class WebGLErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // Graceful fallback to CSS gradient
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function LedgerNetworkLattice() {
  const outerRef = useRef<THREE.Mesh>(null);
  const innerRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    // Slow, ambient rotation suggesting a distributed cryptographic ledger
    if (outerRef.current) {
      outerRef.current.rotation.y += delta * 0.08;
      outerRef.current.rotation.x += delta * 0.03;
    }
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.05;
      innerRef.current.rotation.z += delta * 0.04;
    }
  });

  return (
    <group position={[1.4, 0, 0]}>
      {/* Primary outer wireframe lattice - muted amber/gold tones */}
      <mesh ref={outerRef}>
        <icosahedronGeometry args={[2.2, 1]} />
        <meshBasicMaterial
          wireframe
          color="#c5a757"
          transparent
          opacity={0.4}
        />
      </mesh>

      {/* Secondary inner geometric core - muted charcoal/slate tones */}
      <mesh ref={innerRef}>
        <octahedronGeometry args={[1.3, 0]} />
        <meshBasicMaterial
          wireframe
          color="#757970"
          transparent
          opacity={0.3}
        />
      </mesh>
    </group>
  );
}

export default function HeaderNetwork3D() {
  const [mounted, setMounted] = useState(false);
  const [webGLSupported, setWebGLSupported] = useState(true);

  useEffect(() => {
    setMounted(true);
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) setWebGLSupported(false);
    } catch {
      setWebGLSupported(false);
    }
  }, []);

  if (!mounted) {
    return <div className="header-3d-fallback" aria-hidden="true" />;
  }

  if (!webGLSupported) {
    return <div className="header-3d-fallback" aria-hidden="true" />;
  }

  return (
    <div className="header-3d-canvas" aria-hidden="true">
      <WebGLErrorBoundary fallback={<div className="header-3d-fallback" />}>
        <Canvas
          camera={{ position: [0, 0, 5], fov: 42 }}
          gl={{ antialias: false, powerPreference: 'low-power' }}
          dpr={[1, 1.5]}
        >
          <LedgerNetworkLattice />
        </Canvas>
      </WebGLErrorBoundary>
    </div>
  );
}
