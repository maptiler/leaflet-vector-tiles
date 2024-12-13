import * as maptilersdk from "@maptiler/sdk";
import L from "leaflet";

import packagejson from "../package.json";

// Are exported as well as being placed inside the Leaflet `L` object.
export let MaptilerLayer = null;
export let maptilerLayer = null;
export let MaptilerStyle = null;
export let maptilerStyle = null;
export let MaptilerLanguage = null;
export let maptilerLanguage = null;

export function init() {
  L.MaptilerLayer = L.Layer.extend({
    options: {
      updateInterval: 32,
      // How much to extend the overlay view (relative to map size)
      // e.g. 0.1 would be 10% of map view in each direction
      padding: 0.1,
      // whether or not to register the mouse and keyboard
      // events on the maptiler sdk overlay
      interactive: false,
      // set the tilepane as the default pane to draw gl tiles
      pane: "tilePane",
    },

    map: null,

    initialize: function (options) {
      L.setOptions(this, options);

      // setup throttling the update event when panning
      this._throttledUpdate = L.Util.throttle(
        this._update,
        this.options.updateInterval,
        this
      );
    },

    onAdd: function (map) {
      if (!this._container) {
        this._initContainer();
      }

      const paneName = this.getPaneName();
      map.getPane(paneName).appendChild(this._container);

      this._initMaptilerSDK();

      this._offset = this._map.containerPointToLayerPoint([0, 0]);

      // work around https://github.com/mapbox/mapbox-gl-leaflet/issues/47
      if (map.options.zoomAnimation) {
        L.DomEvent.on(
          map._proxy,
          L.DomUtil.TRANSITION_END,
          this._transitionEnd,
          this
        );
      }

      // Adding MapTiler attribution
      map.attributionControl.addAttribution(
        '\u003ca href="https://www.maptiler.com/copyright/" target="_blank"\u003e\u0026copy; MapTiler\u003c/a\u003e \u003ca href="https://www.openstreetmap.org/copyright" target="_blank"\u003e\u0026copy; OpenStreetMap contributors\u003c/a\u003e'
      );
    },

    onRemove: function (map) {
      if (this._map._proxy && this._map.options.zoomAnimation) {
        L.DomEvent.off(
          this._map._proxy,
          L.DomUtil.TRANSITION_END,
          this._transitionEnd,
          this
        );
      }
      const paneName = this.getPaneName();
      map.getPane(paneName).removeChild(this._container);

      this._maptilerMap.remove();
      this._maptilerMap = null;
    },

    getEvents: function () {
      return {
        move: this._throttledUpdate, // sensibly throttle updating while panning
        zoomanim: this._animateZoom, // applys the zoom animation to the <canvas>
        zoom: this._pinchZoom, // animate every zoom event for smoother pinch-zooming
        zoomstart: this._zoomStart, // flag starting a zoom to disable panning
        zoomend: this._zoomEnd,
        resize: this._resize,
      };
    },

    getMaptilerSDKMap: function () {
      return this._maptilerMap;
    },

    getCanvas: function () {
      return this._maptilerMap.getCanvas();
    },

    getSize: function () {
      return this._map.getSize().multiplyBy(1 + this.options.padding * 2);
    },

    getBounds: function () {
      const halfSize = this.getSize().multiplyBy(0.5);
      const center = this._map.latLngToContainerPoint(this._map.getCenter());
      return L.latLngBounds(
        this._map.containerPointToLatLng(center.subtract(halfSize)),
        this._map.containerPointToLatLng(center.add(halfSize))
      );
    },

    getContainer: function () {
      return this._container;
    },

    // returns the pane name set in options if it is a valid pane, defaults to tilePane
    getPaneName: function () {
      return this._map.getPane(this.options.pane)
        ? this.options.pane
        : "tilePane";
    },

    setStyle: function (s) {
      this._maptilerMap.setStyle(s);
    },

    setLanguage: function (l) {
      this._maptilerMap.setLanguage(l);
    },

    _roundPoint: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }),

    _initContainer: function () {
      this._container = L.DomUtil.create("div", "leaflet-gl-layer");

      const size = this.getSize();
      const offset = this._map.getSize().multiplyBy(this.options.padding);
      this._container.style.width = `${size.x}px`;
      this._container.style.height = `${size.y}px`;

      const topLeft = this._map
        .containerPointToLayerPoint([0, 0])
        .subtract(offset);
      L.DomUtil.setPosition(this._container, this._roundPoint(topLeft));
    },

    _initMaptilerSDK: function () {
      const center = this._map.getCenter();
      let style = this.options.style;
      let apiKey = this.options.apiKey;

      // If the style is a MapTiler style, then it will probably come with an API key
      if (
        (typeof this.options.style === "string" ||
          this.options.style instanceof String) &&
        this.options.style.startsWith("https://api.maptiler.com/maps/")
      ) {
        try {
          const styleURL = new URL(this.options.style);
          const apiKeyFromURL = styleURL.searchParams.get("key");

          if (apiKeyFromURL) {
            apiKey = apiKeyFromURL;
            styleURL.searchParams.delete("key");
            style = styleURL.href;
          }
        } catch (e) {
          console.error(e);
        }
      }

      const options = {
        ...this.options,
        projection: "mercator",
        style,
        apiKey,
        container: this._container,
        center: [center.lng, center.lat],
        zoom: this._map.getZoom() - 1,
        attributionControl: false,
      };

      // if the geolocate MapTiiler SDK option was given, then the center should be removed
      if (this.options.geolocate) {
        options.center = undefined;
        options.zoom = undefined;
      }

      this._maptilerMap = new maptilersdk.Map(options);

      this._maptilerMap.telemetry.registerModule(
        packagejson.name,
        packagejson.version
      );

      this._maptilerMap.once("load", () => {
        this.fire("ready");
      });

      this._maptilerMap.once("load", async () => {
        let tileJsonContent = { logo: null };

        try {
          const possibleSources = Object.keys(
            this._maptilerMap.style.sourceCaches
          )
            .map((sourceName) => this._maptilerMap.getSource(sourceName))
            .filter(
              (s) =>
                s &&
                "url" in s &&
                typeof s.url === "string" &&
                s?.url.includes("tiles.json")
            );

          const styleUrl = new URL(possibleSources[0].url);

          if (!styleUrl.searchParams.has("key")) {
            styleUrl.searchParams.append("key", apiKey);
          }

          const tileJsonRes = await fetch(styleUrl.href);
          tileJsonContent = await tileJsonRes.json();
        } catch (e) {
          // No tiles.json found (should not happen on maintained styles)
        }

        if (tileJsonContent.logo || options.maptilerLogo) {
          const logoURL =
            tileJsonContent.logo ??
            "https://api.maptiler.com/resources/logo.svg";

          // Adding MapTiler logo + link
          const maptilerLink = document.createElement("a");
          maptilerLink.href = "https://www.maptiler.com";
          maptilerLink.style =
            "position:absolute; left:10px; bottom:2px; z-index:999;";
          const maptilerLogo = document.createElement("img");
          maptilerLogo.src = logoURL;
          maptilerLogo.alt = "MapTiler logo";
          maptilerLogo.width = "100";
          maptilerLogo.height = "30";
          maptilerLink.appendChild(maptilerLogo);
          this._map.getContainer().appendChild(maptilerLink);
        }
      });

      this._maptilerMap.transform.freezeElevation = true;

      // if the geolocate MapTiiler SDK option was given, then we need to propagate the actual center to Leaflet map
      if (this.options.geolocate) {
        this._maptilerMap.on("load", () => {
          this._map.setView(
            this._maptilerMap.getCenter(),
            this._maptilerMap.getZoom() + 1
          );
        });
      }

      // allow GL base map to pan beyond min/max latitudes
      // this._maptilerMap.transform.latRange = null;
      // this._maptilerMap.transform.maxValidLatitude = Infinity;
      this._transformGL();
      this._maptilerMap._actualCanvas = this._maptilerMap._canvas;

      // treat child <canvas> element like L.ImageOverlay
      const canvas = this._maptilerMap._actualCanvas;
      L.DomUtil.addClass(canvas, "leaflet-image-layer");
      L.DomUtil.addClass(canvas, "leaflet-zoom-animated");
      if (this.options.interactive) {
        L.DomUtil.addClass(canvas, "leaflet-interactive");
      }
      if (this.options.className) {
        L.DomUtil.addClass(canvas, this.options.className);
      }

      // adding the helpers to be exposed
      for (const k of Object.keys(maptilersdk.helpers)) {
        this[k] = (options) => {
          return maptilersdk.helpers[k].apply(null, [
            this._maptilerMap,
            options,
          ]);
        };
      }
    },

    _update: function () {
      // update the offset so we can correct for it later when we zoom
      this._offset = this._map.containerPointToLayerPoint([0, 0]);

      if (this._zooming) {
        return;
      }

      const size = this.getSize();
      const offset = this._map.getSize().multiplyBy(this.options.padding);
      const topLeft = this._map
        .containerPointToLayerPoint([0, 0])
        .subtract(offset);

      L.DomUtil.setPosition(this._container, this._roundPoint(topLeft));

      this._transformGL();

      if (
        this._maptilerMap.transform.width !== size.x ||
        this._maptilerMap.transform.height !== size.y
      ) {
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        if (
          this._maptilerMap._resize !== null &&
          this._maptilerMap._resize !== undefined
        ) {
          this._maptilerMap._resize();
        } else {
          this._maptilerMap.resize();
        }
      } else {
        // older versions of mapbox-gl surfaced update publicly
        if (
          this._maptilerMap._update !== null &&
          this._maptilerMap._update !== undefined
        ) {
          this._maptilerMap._update();
        } else {
          this._maptilerMap.update();
        }
      }
    },

    _transformGL: function () {
      this._maptilerMap.setCenter(this._map.getCenter());
      this._maptilerMap.setZoom(this._map.getZoom() - 1);
    },

    // update the map constantly during a pinch zoom
    _pinchZoom: function () {
      this._maptilerMap.jumpTo({
        zoom: this._map.getZoom() - 1,
        center: this._map.getCenter(),
      });
    },

    // borrowed from L.ImageOverlay
    // https://github.com/Leaflet/Leaflet/blob/master/src/layer/ImageOverlay.js#L139-L144
    _animateZoom: function (e) {
      const scale = this._map.getZoomScale(e.zoom);
      const padding = this._map
        .getSize()
        .multiplyBy(this.options.padding * scale);
      const viewHalf = this.getSize()._divideBy(2);
      // corrections for padding (scaled), adapted from
      // https://github.com/Leaflet/Leaflet/blob/master/src/map/Map.js#L1490-L1508
      const topLeft = this._map
        .project(e.center, e.zoom)
        ._subtract(viewHalf)
        ._add(this._map._getMapPanePos().add(padding))
        ._round();
      const offset = this._map
        .project(this._map.getBounds().getNorthWest(), e.zoom)
        ._subtract(topLeft);

      L.DomUtil.setTransform(
        this._maptilerMap._actualCanvas,
        offset.subtract(this._offset),
        scale
      );
    },

    _zoomStart: function () {
      this._zooming = true;
    },

    _zoomEnd: function () {
      const scale = this._map.getZoomScale(this._map.getZoom());

      L.DomUtil.setTransform(
        this._maptilerMap._actualCanvas,
        // https://github.com/mapbox/mapbox-gl-leaflet/pull/130
        null,
        scale
      );

      this._zooming = false;
      this._update();
    },

    _transitionEnd: function () {
      L.Util.requestAnimFrame(function () {
        const zoom = this._map.getZoom();
        const center = this._map.getCenter();
        const offset = this._map.latLngToContainerPoint(
          this._map.getBounds().getNorthWest()
        );

        // reset the scale and offset
        L.DomUtil.setTransform(this._maptilerMap._actualCanvas, offset, 1);

        // enable panning once the gl map is ready again
        this._maptilerMap.once(
          "moveend",
          L.Util.bind(function () {
            this._zoomEnd();
          }, this)
        );

        // update the map position
        this._maptilerMap.jumpTo({
          center: center,
          zoom: zoom - 1,
        });
      }, this);
    },

    _resize: function (e) {
      this._transitionEnd(e);
    },
  });
  MaptilerLayer = L.MaptilerLayer;

  L.maptilerLayer = (options) => new L.MaptilerLayer(options);
  maptilerLayer = L.maptilerLayer;

  // exposing the styles
  L.MaptilerStyle = {};
  for (const k of Object.keys(maptilersdk.MapStyle)) {
    L.MaptilerStyle[k] = maptilersdk.MapStyle[k];
  }

  MaptilerStyle = L.MaptilerStyle;
  maptilerStyle = L.MaptilerStyle;
  L.maptilerStyle = L.MaptilerStyle;

  // exposing the languages
  L.MaptilerLanguage = {};
  for (const k of Object.keys(maptilersdk.Language)) {
    L.MaptilerLanguage[k] = maptilersdk.Language[k];
  }

  MaptilerLanguage = L.MaptilerLanguage;
  maptilerLanguage = L.MaptilerLanguage;
  L.maptilerLanguage = L.MaptilerLanguage;
}

(() => {
  try {
    init();
  } catch (e) {
    console.error(e);
  }
})();
