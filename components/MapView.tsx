"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import maplibregl from "maplibre-gl";
import * as turf from "@turf/turf";
import { TerraDraw, TerraDrawPolygonMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { LAND_USE_CATEGORIES } from "@/lib/landuse";
import { Parcel } from "@/lib/types";

export interface MapViewHandle {
  zoomToIsland: (feature: Feature<Polygon>) => void;
  startDraw: () => void;
  stopDraw: () => void;
}

interface MapViewProps {
  islands: FeatureCollection | null;
  boundary: Feature<Polygon> | null;
  parcels: Parcel[];
  selectedIslandId: string | null;
  onPolygonDrawn: (geom: Polygon) => void;
}

// Esri World Imagery — free satellite tiles, no API key required.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Imagery © Esri",
      maxzoom: 19,
    },
  },
  layers: [{ id: "satellite", type: "raster", source: "satellite" }],
};

const EMPTY_FC: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  { islands, boundary, parcels, selectedIslandId, onPolygonDrawn },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const loadedRef = useRef(false);
  const onPolygonDrawnRef = useRef(onPolygonDrawn);
  onPolygonDrawnRef.current = onPolygonDrawn;

  // ---- init map once ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: [73.51, 4.17],
      zoom: 10,
    });
    map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    mapRef.current = map;

    map.on("load", () => {
      // sources
      map.addSource("islands", { type: "geojson", data: EMPTY_FC });
      map.addSource("boundary", { type: "geojson", data: EMPTY_FC });
      map.addSource("parcels", { type: "geojson", data: EMPTY_FC });

      // island fills
      map.addLayer({
        id: "islands-fill",
        type: "fill",
        source: "islands",
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "islands-line",
        type: "line",
        source: "islands",
        paint: { "line-color": "#38bdf8", "line-width": 1.5 },
      });

      // parcels — colored by land use via data-driven styling
      const colorMatch: any = ["match", ["get", "landUse"]];
      LAND_USE_CATEGORIES.forEach((c) => colorMatch.push(c.key, c.color));
      colorMatch.push("#9ca3af");
      map.addLayer({
        id: "parcels-fill",
        type: "fill",
        source: "parcels",
        paint: { "fill-color": colorMatch, "fill-opacity": 0.55 },
      });
      map.addLayer({
        id: "parcels-line",
        type: "line",
        source: "parcels",
        paint: { "line-color": colorMatch, "line-width": 2 },
      });
      map.addLayer({
        id: "parcels-label",
        type: "symbol",
        source: "parcels",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#0f172a",
          "text-halo-width": 1.5,
        },
      });

      // boundary outline (on top)
      map.addLayer({
        id: "boundary-fill",
        type: "fill",
        source: "boundary",
        paint: { "fill-color": "#facc15", "fill-opacity": 0.05 },
      });
      map.addLayer({
        id: "boundary-line",
        type: "line",
        source: "boundary",
        paint: {
          "line-color": "#facc15",
          "line-width": 3,
          "line-dasharray": [2, 1],
        },
      });

      // Terra Draw setup
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [new TerraDrawPolygonMode()],
      });
      draw.start();
      draw.on("finish", (id: string | number) => {
        const snapshot = draw.getSnapshot();
        const f = snapshot.find((s: any) => s.id === id);
        if (f && f.geometry && f.geometry.type === "Polygon") {
          onPolygonDrawnRef.current(f.geometry as Polygon);
        }
        draw.clear();
      });
      drawRef.current = draw;
      loadedRef.current = true;

      // push any data that arrived before load
      pushData();
    });

    return () => {
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- keep GL sources in sync with React state ----
  function pushData() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    (map.getSource("islands") as maplibregl.GeoJSONSource | undefined)?.setData(
      islands || EMPTY_FC
    );

    (map.getSource("boundary") as maplibregl.GeoJSONSource | undefined)?.setData(
      boundary
        ? { type: "FeatureCollection", features: [boundary] }
        : EMPTY_FC
    );

    const parcelFC: FeatureCollection = {
      type: "FeatureCollection",
      features: parcels.map((p) => ({
        type: "Feature",
        geometry: p.geometry,
        properties: {
          landUse: p.landUse,
          label: `${p.landUse} · ${Math.round(p.areaSqm).toLocaleString()} m²`,
        },
      })),
    };
    (map.getSource("parcels") as maplibregl.GeoJSONSource | undefined)?.setData(
      parcelFC
    );
  }

  useEffect(() => {
    pushData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [islands, boundary, parcels]);

  // ---- imperative API ----
  useImperativeHandle(ref, () => ({
    zoomToIsland(feature) {
      const map = mapRef.current;
      if (!map) return;
      const bbox = turf.bbox(feature) as [number, number, number, number];
      map.fitBounds(bbox, { padding: 80, duration: 1000, maxZoom: 17 });
    },
    startDraw() {
      drawRef.current?.setMode("polygon");
    },
    stopDraw() {
      drawRef.current?.setMode("static");
    },
  }));

  return <div ref={containerRef} className="absolute inset-0" />;
});

export default MapView;
