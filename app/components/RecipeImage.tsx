'use client';

import { useEffect, useState } from 'react';
import { recipePhotoCandidates } from '../../lib/recipe-photo';

interface RecipeImageProps {
  recipe: { title: string; heroImage?: string | null };
  alt?: string;
  loading?: 'lazy' | 'eager';
  className?: string;
  showCredit?: boolean | 'compact';
}

/** The same source → title-matched stock → bundled meal fallback in every view. */
export function RecipeImage({ recipe, alt, loading, className, showCredit = false }: RecipeImageProps) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  useEffect(() => { setFailed(new Set()); }, [recipe.title, recipe.heroImage]);
  useEffect(() => {
    const retry = () => setFailed(new Set());
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
  const photo = recipePhotoCandidates(recipe.title, recipe.heroImage).find(({ src }) => !failed.has(src));
  if (!photo) return <span className={`image-fallback ${className ?? ''}`} role={alt === '' ? undefined : 'img'} aria-label={alt === '' ? undefined : recipe.title} />;
  const description = photo.illustrative ? `Illustrative ${photo.label} photo` : undefined;
  return (
    <>
      <img
        key={photo.src}
        src={photo.src}
        alt={alt === '' ? '' : photo.illustrative ? `${description} for ${alt ?? (recipe.title || 'your recipe')}` : alt ?? recipe.title}
        title={description}
        data-photo-kind={photo.illustrative ? 'illustrative' : 'source'}
        loading={loading}
        className={className}
        referrerPolicy="no-referrer"
        onError={() => setFailed((previous) => new Set([...previous, photo.src]))}
      />
      {showCredit && photo.illustrative ? (
        <span className="recipe-photo-credit">
          {photo.credits ? <a href={photo.credits} target="_blank" rel="noreferrer">{showCredit === 'compact' ? 'Illustrative · Credits' : 'Illustrative photo · Credits'}</a> : 'Illustrative photo'}
        </span>
      ) : null}
    </>
  );
}
