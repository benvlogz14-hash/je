import React from 'react';
import { Composition } from 'remotion';
import { PoliticalAd } from './PoliticalAd.jsx';

export const Root = () => (
  <Composition
    id="PoliticalAd"
    component={PoliticalAd}
    durationInFrames={300}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ spec: null }}
    calculateMetadata={({ props }) => {
      const s = props.spec || {};
      const fps = s.fps || 30;
      return { durationInFrames: Math.max(1, Math.round((s.total || 10) * fps)), fps, width: s.w || 1080, height: s.h || 1920 };
    }}
  />
);
