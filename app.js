/* ============================================================
   American Redlining Atlas — app.js
   Multi-city interactive layered map of spatial inequality
   ============================================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const state = {
    currentDecade: 2020,
    activeLayers: new Set(),
    layerData: {},
    layerGroups: {},
    map: null,
    timelineEvents: [],
    narrativeDismissed: new Set(),
    // Capital Flow state
    capitalIndicator: 'displacement_risk',
    capitalData: null,
    // Political Districts state
    politicalType: 'congressional',
    // Multi-city state
    currentCity: null,
    cityConfig: {},
    cityMeta: {},
  };

  // ── Income color scale (viridis-like) ──────────────────────
  const incomeScale = chroma.scale('viridis').domain([20000, 250000]);

  // ── Capital Flow indicator definitions ─────────────────────
  const CAPITAL_INDICATORS = {
    displacement_risk: {
      label: 'Displacement Risk',
      unit: '0-100',
      domain: [10, 90],
      scale: chroma.scale(['#1a9850', '#fee08b', '#d73027']),
      format: function (v) { return v != null ? v.toFixed(0) + '/100' : 'N/A'; },
      description: 'Composite score measuring gentrification displacement pressure',
    },
    price_trajectory: {
      label: 'Price Trajectory',
      unit: '%',
      domain: [-5, 60],
      scale: chroma.scale(['#2166ac', '#f7f7f7', '#b2182b']),
      format: function (v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : 'N/A'; },
      description: '3-year median home price growth rate',
    },
    listing_velocity: {
      label: 'Listing Velocity',
      unit: 'ratio',
      domain: [0.3, 3.0],
      scale: chroma.scale(['#4575b4', '#ffffbf', '#d73027']),
      format: function (v) { return v != null ? v.toFixed(2) + 'x' : 'N/A'; },
      description: 'New listings / active inventory ratio (market heat)',
    },
    rental_yield: {
      label: 'Rental Yield',
      unit: '%',
      domain: [2, 10],
      scale: chroma.scale(['#f1eef6', '#d7b5d8', '#980043']),
      format: function (v) { return v != null ? v.toFixed(1) + '%' : 'N/A'; },
      description: 'Gross rental yield (annual rent / home value)',
    },
    investor_activity: {
      label: 'Investor Activity',
      unit: '0-100',
      domain: [10, 80],
      scale: chroma.scale(['#edf8fb', '#b2e2e2', '#238b45']).domain([10, 45, 80]),
      format: function (v) { return v != null ? v.toFixed(0) + '/100' : 'N/A'; },
      description: 'Composite investor activity index',
    },
    dom_shift: {
      label: 'DOM Shift',
      unit: 'days',
      domain: [-20, 10],
      scale: chroma.scale(['#d73027', '#fee08b', '#1a9850']),
      format: function (v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(0) + ' days' : 'N/A'; },
      description: 'Days-on-market change (negative = selling faster)',
    },
    flip_rate: {
      label: 'Flip Rate',
      unit: '%',
      domain: [1, 20],
      scale: chroma.scale(['#ffffcc', '#fd8d3c', '#800026']),
      format: function (v) { return v != null ? v.toFixed(1) + '%' : 'N/A'; },
      description: 'Estimated short-hold resale percentage',
    },
    affordability_cliff: {
      label: 'Affordability Cliff',
      unit: 'ratio',
      domain: [0.5, 3.5],
      scale: chroma.scale(['#1a9850', '#fee08b', '#d73027']),
      format: function (v) { return v != null ? v.toFixed(2) + 'x' : 'N/A'; },
      description: 'Home price / (4x median income) — above 1.0 = unaffordable',
    },
  };

  // ── Party colors ──────────────────────────────────────────
  const partyColors = {
    D: '#3b82f6',
    R: '#ef4444',
    Unknown: '#6b7280',
  };

  // ── Race colors ────────────────────────────────────────────
  const raceColors = {
    white: '#1b9e77',
    black: '#d95f02',
    hispanic: '#7570b3',
    asian: '#e7298a',
    diverse: '#66a61e',
  };

  // ── HOLC colors ────────────────────────────────────────────
  const holcColors = {
    A: '#4daf4a',
    B: '#377eb8',
    C: '#ffff33',
    D: '#e41a1c',
  };

  // ── Decade → income field mapping ──────────────────────────
  function incomeField(decade) {
    if (decade <= 1970) return 'income_1970';
    if (decade <= 1980) return 'income_1980';
    if (decade <= 1990) return 'income_1990';
    if (decade <= 2000) return 'income_2000';
    if (decade <= 2010) return 'income_2010';
    return 'income_2020';
  }

  // ── Decade → race field suffix ─────────────────────────────
  function raceSuffix(decade) {
    if (decade <= 1970) return '_1970';
    if (decade <= 1990) return '_1990';
    return '_2020';
  }

  // ── Helpers ────────────────────────────────────────────────
  function formatMoney(n) {
    if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
    return '$' + n;
  }

  function pct(v) {
    return (v != null ? v.toFixed(1) : '—') + '%';
  }

  // ── Initialize Map ─────────────────────────────────────────
  function initMap() {
    state.map = L.map('map', {
      center: [39.8283, -98.5795],  // center of US
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(state.map);
  }

  // ── City Config Loading ───────────────────────────────────
  async function loadCityConfig() {
    var resp = await fetch('data/cities.json');
    state.cityConfig = await resp.json();
  }

  // ── City Search / Dropdown ────────────────────────────────
  function initCitySearch() {
    var input = document.getElementById('city-search');
    var dropdown = document.getElementById('city-dropdown');
    var cities = state.cityConfig.cities;
    var slugs = Object.keys(cities).sort(function (a, b) {
      return cities[a].label.localeCompare(cities[b].label);
    });

    function renderDropdown(filter) {
      var html = '';
      var count = 0;
      slugs.forEach(function (slug) {
        var c = cities[slug];
        var label = c.label + ', ' + c.state;
        if (filter && label.toLowerCase().indexOf(filter.toLowerCase()) === -1) return;
        var activeClass = slug === state.currentCity ? ' active' : '';
        var featuredBadge = c.featured ? ' <span class="city-featured">★</span>' : '';
        html += '<div class="city-option' + activeClass + '" data-slug="' + slug + '">' +
          label + featuredBadge + '</div>';
        count++;
      });
      if (count === 0) {
        html = '<div class="city-option disabled">No cities found</div>';
      }
      dropdown.innerHTML = html;
      dropdown.classList.remove('hidden');

      // Attach click handlers
      dropdown.querySelectorAll('.city-option:not(.disabled)').forEach(function (el) {
        el.addEventListener('click', function () {
          var slug = el.getAttribute('data-slug');
          input.value = '';
          dropdown.classList.add('hidden');
          switchCity(slug);
        });
      });
    }

    input.addEventListener('focus', function () {
      renderDropdown(input.value);
    });

    input.addEventListener('input', function () {
      renderDropdown(input.value);
    });

    // Close dropdown on outside click
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.city-selector')) {
        dropdown.classList.add('hidden');
      }
    });

    // Keyboard navigation
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
        input.blur();
      }
    });
  }

  // ── Switch City ───────────────────────────────────────────
  async function switchCity(slug) {
    var config = state.cityConfig.cities[slug];
    if (!config) return;

    state.currentCity = slug;
    state.cityMeta = config;

    // Clear all layers from map
    Object.keys(state.layerGroups).forEach(function (name) {
      if (state.map.hasLayer(state.layerGroups[name])) {
        state.map.removeLayer(state.layerGroups[name]);
      }
    });

    // Reset state
    state.layerData = {};
    state.activeLayers = new Set();
    state.narrativeDismissed = new Set();
    state.timelineEvents = [];
    state.capitalData = null;
    state.capitalIndicator = 'displacement_risk';
    state.politicalType = config.politicalTypes ? config.politicalTypes[0] : 'congressional';

    // Re-create layer groups
    var allLayers = ['redlining', 'highways', 'income', 'race', 'floods', 'pollution', 'capital', 'political'];
    allLayers.forEach(function (name) {
      state.layerGroups[name] = L.layerGroup();
    });

    // Move map
    state.map.setView(config.center, config.zoom);

    // Update UI text
    document.getElementById('atlas-title').textContent = config.label + ' Inequality Map';
    document.getElementById('city-subtitle').textContent =
      'Layers of Spatial History, ' + config.decadeMin + 's–2020s';
    document.getElementById('holc-year-label').textContent = '(' + config.holcYear + ')';
    document.getElementById('about-city-text').textContent = config.about || '';

    // Show/hide layer groups based on city's available layers
    var layerIds = {
      redlining: 'group-redlining',
      highways: 'group-highways',
      income: 'group-income',
      race: 'group-race',
      floods: 'group-floods',
      pollution: 'group-pollution',
      capital: 'group-capital',
      political: 'group-political',
    };

    Object.keys(layerIds).forEach(function (layer) {
      var el = document.getElementById(layerIds[layer]);
      if (!el) return;
      if (config.layers.indexOf(layer) >= 0) {
        el.classList.remove('hidden-layer-group');
      } else {
        el.classList.add('hidden-layer-group');
      }
    });

    // Rebuild political dropdown
    var polSelect = document.getElementById('political-type-select');
    if (polSelect && config.politicalTypes) {
      polSelect.innerHTML = '';
      var typeLabels = {
        congressional: 'Congressional',
        state_senate: 'State Senate',
        state_assembly: 'State Assembly',
        state_house: 'State House',
        borough_president: 'Borough President',
        commissioner: 'Commissioner',
        city_council: 'City Council',
      };
      config.politicalTypes.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = typeLabels[t] || t;
        polSelect.appendChild(opt);
      });
      polSelect.value = state.politicalType;
    }

    // Rebuild timeline
    rebuildTimeline(config.decadeMin);

    // Uncheck all layer toggles
    document.querySelectorAll('.layer-toggle input').forEach(function (input) {
      input.checked = false;
      input.closest('.layer-group').classList.remove('active');
    });

    // Load data for this city
    await loadAllData(slug);

    // Enable redlining by default
    var redliningCheckbox = document.getElementById('layer-redlining');
    if (redliningCheckbox && config.layers.indexOf('redlining') >= 0) {
      redliningCheckbox.checked = true;
      redliningCheckbox.dispatchEvent(new Event('change'));
    }

    // Show initial narrative
    showNarrativeForDecade(state.currentDecade);
  }

  // ── Data Loading ───────────────────────────────────────────
  async function loadAllData(slug) {
    var base = 'data/cities/' + slug;
    var layers = state.cityMeta.layers;
    var loads = [];

    if (layers.indexOf('redlining') >= 0) {
      loads.push(fetch(base + '/redlining.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.redlining = d; }));
    }
    if (layers.indexOf('highways') >= 0) {
      loads.push(fetch(base + '/highways.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.highways = d; }));
    }
    if (layers.indexOf('income') >= 0) {
      loads.push(fetch(base + '/income.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.income = d; }));
    }
    if (layers.indexOf('race') >= 0) {
      loads.push(fetch(base + '/race.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.race = d; }));
    }
    if (layers.indexOf('floods') >= 0) {
      loads.push(fetch(base + '/flood_zones.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.floods = d; }));
    }
    if (layers.indexOf('pollution') >= 0) {
      loads.push(fetch(base + '/tri_sites.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.pollution = d; }));
    }
    if (layers.indexOf('capital') >= 0) {
      loads.push(fetch(base + '/capital.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.capital = d; state.capitalData = d; }));
    }
    if (layers.indexOf('political') >= 0) {
      loads.push(fetch(base + '/political.geojson').then(function (r) { return r.json(); }).then(function (d) { state.layerData.political = d; }));
    }
    // Always try timeline
    loads.push(fetch(base + '/timeline.json').then(function (r) { return r.json(); }).then(function (d) { state.timelineEvents = d; }));

    var results = await Promise.allSettled(loads);
    results.forEach(function (r) {
      if (r.status === 'rejected') {
        console.warn('Failed to load data:', r.reason);
      }
    });
  }

  // ── Build Layers ───────────────────────────────────────────

  function buildRedliningLayer() {
    var group = state.layerGroups.redlining;
    group.clearLayers();
    var data = state.layerData.redlining;
    if (!data) return;

    L.geoJSON(data, {
      style: function (feature) {
        var grade = feature.properties.holc_grade;
        return {
          fillColor: holcColors[grade] || '#888',
          fillOpacity: 0.35,
          color: holcColors[grade] || '#888',
          weight: 1.5,
          opacity: 0.8,
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('click', function () {
          showInfoPanel(feature, 'redlining');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.55, weight: 2.5 });
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.35, weight: 1.5 });
        });
      },
    }).addTo(group);
  }

  function buildHighwayLayer() {
    var group = state.layerGroups.highways;
    group.clearLayers();
    var data = state.layerData.highways;
    if (!data) return;

    var decade = state.currentDecade;

    data.features.forEach(function (feature) {
      var props = feature.properties;
      var constructionDecadeStart = Math.floor(props.construction_year / 10) * 10;

      if (constructionDecadeStart > decade) return;

      var age = decade - constructionDecadeStart;
      var opacity = age >= 20 ? 0.9 : 0.7;

      var line = L.geoJSON(feature, {
        style: {
          color: '#ff8c00',
          weight: 3,
          opacity: opacity,
          dashArray: constructionDecadeStart === decade ? '8 6' : null,
        },
        onEachFeature: function (feat, layer) {
          layer.on('click', function () {
            showInfoPanel(feat, 'highways');
          });
        },
      });
      line.addTo(group);

      if (props.neighborhoods_displaced && props.neighborhoods_displaced.length > 0) {
        var buffer = L.geoJSON(feature, {
          style: {
            color: '#ff8c00',
            weight: 18,
            opacity: 0.08,
            lineCap: 'round',
            lineJoin: 'round',
          },
          interactive: false,
        });
        buffer.addTo(group);
      }

      var labelCoords;
      if (feature.geometry.type === 'MultiLineString') {
        var lines = feature.geometry.coordinates;
        var longest = lines[0];
        for (var k = 1; k < lines.length; k++) {
          if (lines[k].length > longest.length) longest = lines[k];
        }
        labelCoords = longest[Math.floor(longest.length / 2)];
      } else {
        var coords = feature.geometry.coordinates;
        labelCoords = coords[Math.floor(coords.length / 2)];
      }
      if (labelCoords) {
        var label = L.marker([labelCoords[1], labelCoords[0]], {
          icon: L.divIcon({
            className: 'highway-label',
            html: '<span style="background:rgba(13,17,23,0.85);color:#ff8c00;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;white-space:nowrap;font-family:Inter,sans-serif;">' + props.designation + '</span>',
            iconSize: null,
          }),
          interactive: false,
        });
        label.addTo(group);
      }
    });
  }

  function buildIncomeLayer() {
    var group = state.layerGroups.income;
    group.clearLayers();
    var data = state.layerData.income;
    if (!data) return;

    var field = incomeField(state.currentDecade);

    L.geoJSON(data, {
      style: function (feature) {
        var income = feature.properties[field];
        var color = income ? incomeScale(income).hex() : '#333';
        return {
          fillColor: color,
          fillOpacity: 0.6,
          color: 'rgba(255,255,255,0.15)',
          weight: 1,
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('click', function () {
          showInfoPanel(feature, 'income');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.8, weight: 2, color: 'rgba(255,255,255,0.4)' });
          var income = feature.properties[field];
          layer.bindTooltip(
            '<strong>' + feature.properties.name + '</strong><br>' +
            'Income: ' + (income ? '$' + income.toLocaleString() : 'N/A'),
            { sticky: true, className: 'dark-tooltip' }
          ).openTooltip();
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.6, weight: 1, color: 'rgba(255,255,255,0.15)' });
          layer.unbindTooltip();
        });
      },
    }).addTo(group);
  }

  function buildRaceLayer() {
    var group = state.layerGroups.race;
    group.clearLayers();
    var data = state.layerData.race;
    if (!data) return;

    var suffix = raceSuffix(state.currentDecade);

    L.geoJSON(data, {
      style: function (feature) {
        var p = feature.properties;
        var w = p['pct_white' + suffix] || 0;
        var b = p['pct_black' + suffix] || 0;
        var h = p['pct_hispanic' + suffix] || 0;
        var a = p['pct_asian' + suffix] || 0;

        var dominant = 'diverse';
        var max = Math.max(w, b, h, a);
        if (max >= 50) {
          if (w === max) dominant = 'white';
          else if (b === max) dominant = 'black';
          else if (h === max) dominant = 'hispanic';
          else if (a === max) dominant = 'asian';
        }

        return {
          fillColor: raceColors[dominant],
          fillOpacity: 0.5,
          color: 'rgba(255,255,255,0.1)',
          weight: 1,
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('click', function () {
          showInfoPanel(feature, 'race');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.75, weight: 2, color: 'rgba(255,255,255,0.3)' });
          var p = feature.properties;
          var s = raceSuffix(state.currentDecade);
          layer.bindTooltip(
            '<strong>' + p.name + '</strong><br>' +
            'W: ' + pct(p['pct_white' + s]) +
            ' B: ' + pct(p['pct_black' + s]) +
            ' H: ' + pct(p['pct_hispanic' + s]) +
            ' A: ' + pct(p['pct_asian' + s]),
            { sticky: true, className: 'dark-tooltip' }
          ).openTooltip();
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.5, weight: 1, color: 'rgba(255,255,255,0.1)' });
          layer.unbindTooltip();
        });
      },
    }).addTo(group);
  }

  function buildFloodLayer() {
    var group = state.layerGroups.floods;
    group.clearLayers();
    var data = state.layerData.floods;
    if (!data) return;

    L.geoJSON(data, {
      style: function (feature) {
        var risk = feature.properties.flood_risk;
        var isModerate = feature.properties.zone === 'X500' || feature.properties.flood_risk === 'moderate';
        return {
          fillColor: risk === 'coastal' ? '#0066cc' : '#0064ff',
          fillOpacity: isModerate ? 0.1 : (risk === 'high' ? 0.3 : 0.15),
          color: '#0088ff',
          weight: isModerate ? 0.5 : 1,
          opacity: 0.5,
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('click', function () {
          showInfoPanel(feature, 'floods');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.5, weight: 2 });
        });
        layer.on('mouseout', function () {
          var risk = feature.properties.flood_risk;
          var isModerate = feature.properties.zone === 'X500' || feature.properties.flood_risk === 'moderate';
          layer.setStyle({
            fillOpacity: isModerate ? 0.1 : (risk === 'high' ? 0.3 : 0.15),
            weight: isModerate ? 0.5 : 1,
          });
        });
      },
    }).addTo(group);
  }

  function buildPollutionLayer() {
    var group = state.layerGroups.pollution;
    group.clearLayers();
    var data = state.layerData.pollution;
    if (!data) return;

    var decade = state.currentDecade;

    data.features.forEach(function (feature) {
      var p = feature.properties;
      if (decade < 1980) return;
      var firstDecade = Math.floor(p.year_first_reported / 10) * 10;
      if (firstDecade > decade) return;

      var coords = feature.geometry.coordinates;
      var isCarcinogen = p.carcinogen;
      var radius = Math.max(6, Math.min(18, Math.sqrt(p.total_releases_lbs / 10000)));

      var marker = L.circleMarker([coords[1], coords[0]], {
        radius: radius,
        fillColor: isCarcinogen ? '#ff4444' : '#ff8c00',
        fillOpacity: 0.7,
        color: isCarcinogen ? '#ff6666' : '#ffaa44',
        weight: 1.5,
        opacity: 0.9,
      });

      marker.on('click', function () {
        showInfoPanel(feature, 'pollution');
      });

      marker.on('mouseover', function () {
        marker.setStyle({ fillOpacity: 1, radius: radius + 3 });
        marker.bindTooltip(
          '<strong>' + p.facility_name + '</strong><br>' +
          p.top_chemical + (isCarcinogen ? ' (carcinogen)' : '') + '<br>' +
          p.total_releases_lbs.toLocaleString() + ' lbs/yr',
          { className: 'dark-tooltip' }
        ).openTooltip();
      });

      marker.on('mouseout', function () {
        marker.setStyle({ fillOpacity: 0.7, radius: radius });
        marker.unbindTooltip();
      });

      marker.addTo(group);
    });
  }

  // ── Capital Flow Layer ────────────────────────────────────
  function buildCapitalLayer() {
    var group = state.layerGroups.capital;
    group.clearLayers();
    var data = state.layerData.capital;
    if (!data) return;

    var indicatorKey = state.capitalIndicator;
    var indDef = CAPITAL_INDICATORS[indicatorKey];
    if (!indDef) return;

    var scale = indDef.scale.domain(indDef.domain);

    L.geoJSON(data, {
      style: function (feature) {
        var val = feature.properties[indicatorKey];
        var color = val != null ? scale(val).hex() : '#333';
        return {
          fillColor: color,
          fillOpacity: 0.65,
          color: 'rgba(255,255,255,0.2)',
          weight: 1.5,
        };
      },
      onEachFeature: function (feature, layer) {
        layer.on('click', function () {
          showInfoPanel(feature, 'capital');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.85, weight: 2.5, color: 'rgba(255,255,255,0.5)' });
          var p = feature.properties;
          var val = p[indicatorKey];
          layer.bindTooltip(
            '<strong>' + p.zip + ' — ' + p.name + '</strong><br>' +
            indDef.label + ': <strong>' + indDef.format(val) + '</strong>',
            { sticky: true, className: 'dark-tooltip' }
          ).openTooltip();
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.65, weight: 1.5, color: 'rgba(255,255,255,0.2)' });
          layer.unbindTooltip();
        });
      },
    }).addTo(group);

    updateCapitalLegend(indicatorKey);
  }

  function updateCapitalLegend(indicatorKey) {
    var indDef = CAPITAL_INDICATORS[indicatorKey];
    if (!indDef) return;

    var gradient = document.getElementById('capital-gradient');
    if (gradient) {
      var d = indDef.domain;
      var steps = 8;
      var colors = [];
      for (var i = 0; i <= steps; i++) {
        var val = d[0] + (d[d.length - 1] - d[0]) * (i / steps);
        colors.push(indDef.scale.domain(d)(val).hex());
      }
      gradient.style.background = 'linear-gradient(to right, ' + colors.join(', ') + ')';
    }

    var rangeMin = document.getElementById('capital-range-min');
    var rangeMax = document.getElementById('capital-range-max');
    if (rangeMin && rangeMax) {
      var d2 = indDef.domain;
      rangeMin.textContent = indDef.format(d2[0]);
      rangeMax.textContent = indDef.format(d2[d2.length - 1]);
    }

    var descEl = document.getElementById('capital-indicator-desc');
    if (descEl) {
      descEl.textContent = indDef.description;
    }
  }

  // ── Political Districts Layer ─────────────────────────────
  function buildPoliticalLayer() {
    var group = state.layerGroups.political;
    group.clearLayers();
    var data = state.layerData.political;
    if (!data) return;

    var selectedType = state.politicalType;

    var filtered = {
      type: 'FeatureCollection',
      features: data.features.filter(function (f) {
        return f.properties.district_type === selectedType;
      }),
    };

    L.geoJSON(filtered, {
      style: function (feature) {
        var party = feature.properties.party;
        var color = partyColors[party] || partyColors.Unknown;
        return {
          fillColor: color,
          fillOpacity: 0.08,
          color: color,
          weight: 3,
          opacity: 0.9,
          dashArray: '6 4',
        };
      },
      onEachFeature: function (feature, layer) {
        var bounds = layer.getBounds();
        var center = bounds.getCenter();
        var p = feature.properties;
        var partyColor = partyColors[p.party] || partyColors.Unknown;
        var labelText = p.district_number || p.district_id;
        var label = L.marker(center, {
          icon: L.divIcon({
            className: 'political-label',
            html: '<span style="background:rgba(13,17,23,0.85);color:' + partyColor +
              ';padding:2px 6px;border-radius:3px;font-size:11px;font-weight:700;' +
              'white-space:nowrap;font-family:Inter,sans-serif;border:1px solid ' + partyColor + ';">' +
              labelText + '</span>',
            iconSize: null,
          }),
          interactive: false,
        });
        label.addTo(group);

        layer.on('click', function () {
          showInfoPanel(feature, 'political');
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.25, weight: 4, dashArray: null });
          layer.bindTooltip(
            '<strong>' + p.name + '</strong><br>' +
            '<span style="color:' + partyColor + '">' + p.representative + ' (' + p.party + ')</span>',
            { sticky: true, className: 'dark-tooltip' }
          ).openTooltip();
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.08, weight: 3, dashArray: '6 4' });
          layer.unbindTooltip();
        });
      },
    }).addTo(group);
  }

  // ── Layer rebuild dispatcher ───────────────────────────────
  var builders = {
    redlining: buildRedliningLayer,
    highways: buildHighwayLayer,
    income: buildIncomeLayer,
    race: buildRaceLayer,
    floods: buildFloodLayer,
    pollution: buildPollutionLayer,
    capital: buildCapitalLayer,
    political: buildPoliticalLayer,
  };

  function rebuildLayer(name) {
    if (builders[name]) builders[name]();
  }

  function rebuildAllActive() {
    state.activeLayers.forEach(function (name) {
      rebuildLayer(name);
    });
  }

  // ── Info Panel ─────────────────────────────────────────────
  function showInfoPanel(feature, layerType) {
    var panel = document.getElementById('info-panel');
    var content = document.getElementById('info-content');
    var p = feature.properties;
    var html = '';

    switch (layerType) {
      case 'redlining':
        html = buildRedliningInfo(p);
        break;
      case 'highways':
        html = buildHighwayInfo(p);
        break;
      case 'income':
        html = buildIncomeInfo(p);
        break;
      case 'race':
        html = buildRaceInfo(p);
        break;
      case 'floods':
        html = buildFloodInfo(p);
        break;
      case 'pollution':
        html = buildPollutionInfo(p);
        break;
      case 'capital':
        html = buildCapitalInfo(p);
        break;
      case 'political':
        html = buildPoliticalInfo(p);
        break;
    }

    content.innerHTML = html;
    panel.classList.remove('hidden');
  }

  function buildRedliningInfo(p) {
    var gradeLabels = { A: 'Best', B: 'Still Desirable', C: 'Declining', D: 'Hazardous' };
    var grade = p.holc_grade;
    var holcYear = state.cityMeta.holcYear || '1930s';
    return '' +
      '<h3>' + (p.neighborhood_name || p.name || p.holc_id || 'HOLC Zone') + '</h3>' +
      '<div class="info-section">' +
        '<h4>HOLC Grade (' + holcYear + ')</h4>' +
        '<div class="info-row"><span class="label">Grade</span>' +
        '<span class="value" style="color:' + holcColors[grade] + '">' + grade + ' — ' + gradeLabels[grade] + '</span></div>' +
      '</div>' +
      '<div class="info-section">' +
        '<h4>Assessment</h4>' +
        '<p style="font-size:12px;color:var(--text-muted);line-height:1.5;">' + (p.area_description || 'No description available.') + '</p>' +
      '</div>';
  }

  function buildHighwayInfo(p) {
    return '' +
      '<h3>' + p.name + '</h3>' +
      '<div class="info-section">' +
        '<h4>Construction</h4>' +
        '<div class="info-row"><span class="label">Route</span><span class="value">' + p.designation + '</span></div>' +
        '<div class="info-row"><span class="label">Built</span><span class="value">' + p.construction_year + '–' + p.completion_year + '</span></div>' +
        '<div class="info-row"><span class="label">Decade</span><span class="value">' + p.decade + '</span></div>' +
      '</div>' +
      (p.neighborhoods_displaced && p.neighborhoods_displaced.length > 0 ?
        '<div class="info-section">' +
          '<h4>Communities Displaced</h4>' +
          '<p style="font-size:12px;color:var(--danger);line-height:1.5;">' +
            p.neighborhoods_displaced.join(', ') +
          '</p>' +
        '</div>' : '') +
      '<div class="info-section">' +
        '<p style="font-size:12px;color:var(--text-muted);line-height:1.5;">' + (p.description || '') + '</p>' +
      '</div>';
  }

  function buildIncomeInfo(p) {
    var decades = [1970, 1980, 1990, 2000, 2010, 2020];
    var sparkHtml = '<div style="display:flex;align-items:flex-end;gap:3px;height:48px;margin:8px 0;">';
    var maxIncome = Math.max.apply(null, decades.map(function (d) { return p['income_' + d] || 0; }));

    decades.forEach(function (d) {
      var val = p['income_' + d] || 0;
      var h = maxIncome > 0 ? Math.max(4, (val / maxIncome) * 44) : 4;
      var isActive = (d === Math.floor(state.currentDecade / 10) * 10) || (state.currentDecade >= 2020 && d === 2020);
      sparkHtml += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">' +
        '<div style="width:100%;height:' + h + 'px;background:' + (isActive ? 'var(--accent)' : '#30363d') +
        ';border-radius:2px;transition:height 0.3s ease,background 0.3s ease;"></div>' +
        '<span style="font-size:9px;color:var(--text-dim);">' + (d + '').slice(2) + '</span>' +
      '</div>';
    });
    sparkHtml += '</div>';

    return '' +
      '<h3>' + p.name + '</h3>' +
      '<div class="info-section">' +
        '<h4>Median Household Income</h4>' +
        '<div class="info-row"><span class="label">Current (' + incomeField(state.currentDecade).replace('income_', '') + ')</span>' +
        '<span class="value">$' + (p[incomeField(state.currentDecade)] || 0).toLocaleString() + '</span></div>' +
        sparkHtml +
      '</div>' +
      '<div class="info-section">' +
        '<h4>Poverty Rate (2020)</h4>' +
        '<div class="info-row"><span class="label">Rate</span><span class="value">' + pct(p.poverty_rate_2020) + '</span></div>' +
        '<div class="info-bar"><div class="info-bar-fill" style="width:' + Math.min(100, p.poverty_rate_2020 || 0) + '%;background:' +
        (p.poverty_rate_2020 > 30 ? 'var(--danger)' : p.poverty_rate_2020 > 15 ? 'var(--warning)' : 'var(--success)') + ';"></div></div>' +
      '</div>' +
      '<div class="info-section"><p style="font-size:11px;color:var(--text-dim);font-style:italic;">' +
      (p.is_sample_data ? 'Sample data for illustration' : '2020 values from ACS 2022 5-Year Estimates; historical decades are modeled') +
      '</p></div>';
  }

  function buildRaceInfo(p) {
    var s = raceSuffix(state.currentDecade);
    var suffix1970 = '_1970';
    var groups = [
      { key: 'white', label: 'White', color: raceColors.white },
      { key: 'black', label: 'Black', color: raceColors.black },
      { key: 'hispanic', label: 'Hispanic', color: raceColors.hispanic },
      { key: 'asian', label: 'Asian', color: raceColors.asian },
    ];

    var barsHtml = '';
    groups.forEach(function (g) {
      var val = p['pct_' + g.key + s] || 0;
      barsHtml +=
        '<div style="margin:4px 0;">' +
          '<div class="info-row"><span class="label">' + g.label + '</span><span class="value">' + pct(val) + '</span></div>' +
          '<div class="info-bar"><div class="info-bar-fill" style="width:' + val + '%;background:' + g.color + ';"></div></div>' +
        '</div>';
    });

    var changeHtml = '';
    if (s !== suffix1970 && p['pct_white_1970'] != null) {
      changeHtml = '<div class="info-section"><h4>Change since 1970</h4>';
      groups.forEach(function (g) {
        var old = p['pct_' + g.key + '_1970'] || 0;
        var cur = p['pct_' + g.key + s] || 0;
        var diff = cur - old;
        var sign = diff >= 0 ? '+' : '';
        changeHtml += '<div class="info-row"><span class="label">' + g.label + '</span>' +
          '<span class="value" style="color:' + (Math.abs(diff) > 10 ? 'var(--warning)' : 'var(--text-muted)') + '">' +
          sign + diff.toFixed(1) + '%</span></div>';
      });
      changeHtml += '</div>';
    }

    return '' +
      '<h3>' + p.name + '</h3>' +
      '<div class="info-section">' +
        '<h4>Demographics (' + s.replace('_', '') + ')</h4>' +
        barsHtml +
      '</div>' +
      changeHtml +
      '<div class="info-section"><p style="font-size:11px;color:var(--text-dim);font-style:italic;">' +
      (p.is_sample_data ? 'Sample data for illustration' : '2020 values from ACS 2022 5-Year Estimates; historical decades are modeled') +
      '</p></div>';
  }

  function buildFloodInfo(p) {
    // Generic storm event detection
    var stormHtml = '';
    var stormFields = [
      { key: 'harvey_inundated', label: 'Harvey (2017)' },
      { key: 'sandy_inundated', label: 'Sandy (2012)' },
      { key: 'ida_affected', label: 'Ida (2021)' },
    ];
    stormFields.forEach(function (sf) {
      if (p[sf.key] !== undefined) {
        stormHtml += '<div class="info-section">' +
          '<div class="info-row"><span class="label">' + sf.label + '</span><span class="value" style="color:' +
          (p[sf.key] ? 'var(--danger)' : 'var(--success)') + '">' +
          (p[sf.key] ? 'Inundated' : 'Not flooded') + '</span></div>' +
        '</div>';
      }
    });

    return '' +
      '<h3>Flood Zone ' + (p.zone || '') + (p.name ? ' — ' + p.name : '') + '</h3>' +
      '<div class="info-section">' +
        '<h4>Classification</h4>' +
        '<div class="info-row"><span class="label">Zone</span><span class="value">' + (p.zone || '') + '</span></div>' +
        '<div class="info-row"><span class="label">Risk Level</span><span class="value" style="color:' +
          (p.flood_risk === 'high' || p.flood_risk === 'coastal' ? 'var(--danger)' : 'var(--warning)') + '">' +
          (p.flood_risk || 'unknown') + '</span></div>' +
        (p.bayou ? '<div class="info-row"><span class="label">Waterway</span><span class="value">' + p.bayou + '</span></div>' : '') +
      '</div>' +
      '<div class="info-section">' +
        '<h4>Description</h4>' +
        '<p style="font-size:12px;color:var(--text-muted);line-height:1.5;">' + (p.zone_description || '') + '</p>' +
      '</div>' +
      (p.major_flood_events && p.major_flood_events.length > 0 ?
        '<div class="info-section">' +
          '<h4>Major Flood Events</h4>' +
          '<p style="font-size:12px;color:var(--text-muted);">' + p.major_flood_events.join(', ') + '</p>' +
        '</div>' : '') +
      stormHtml;
  }

  function buildPollutionInfo(p) {
    return '' +
      '<h3>' + p.facility_name + '</h3>' +
      '<div class="info-section">' +
        '<h4>Facility Details</h4>' +
        '<div class="info-row"><span class="label">Industry</span><span class="value">' + (p.industry || 'N/A') + '</span></div>' +
        '<div class="info-row"><span class="label">Reporting since</span><span class="value">' + (p.year_first_reported || 'N/A') + '</span></div>' +
        '<div class="info-row"><span class="label">Risk Score</span><span class="value" style="color:' +
          (p.risk_score >= 8 ? 'var(--danger)' : p.risk_score >= 5 ? 'var(--warning)' : 'var(--text)') + '">' +
          p.risk_score + '/10</span></div>' +
      '</div>' +
      '<div class="info-section">' +
        '<h4>Toxic Releases</h4>' +
        '<div class="info-row"><span class="label">Total releases</span><span class="value">' + (p.total_releases_lbs || 0).toLocaleString() + ' lbs/yr</span></div>' +
        '<div class="info-row"><span class="label">Top chemical</span><span class="value">' + (p.top_chemical || 'N/A') + '</span></div>' +
        '<div class="info-row"><span class="label">Carcinogen</span><span class="value" style="color:' +
          (p.carcinogen ? 'var(--danger)' : 'var(--success)') + '">' +
          (p.carcinogen ? 'Yes' : 'No') + '</span></div>' +
      '</div>' +
      (p.nearby_neighborhoods && p.nearby_neighborhoods.length > 0 ?
        '<div class="info-section">' +
          '<h4>Nearby Communities</h4>' +
          '<p style="font-size:12px;color:var(--text-muted);">' + p.nearby_neighborhoods.join(', ') + '</p>' +
        '</div>' : '');
  }

  function buildCapitalInfo(p) {
    var html = '<h3>' + p.zip + ' — ' + (p.name || '') + '</h3>';

    var risk = p.displacement_risk;
    var riskColor = risk >= 70 ? 'var(--danger)' : risk >= 40 ? 'var(--warning)' : 'var(--success)';
    var riskLabel = risk >= 70 ? 'High Risk' : risk >= 40 ? 'Moderate Risk' : 'Lower Risk';
    html += '<div class="info-section capital-hero">' +
      '<h4>Displacement Risk Score</h4>' +
      '<div style="display:flex;align-items:center;gap:12px;margin:6px 0;">' +
        '<span class="capital-score" style="color:' + riskColor + ';font-size:28px;font-weight:700;">' +
          (risk != null ? risk.toFixed(0) : '—') +
        '</span>' +
        '<div style="flex:1;">' +
          '<div class="info-bar" style="height:8px;"><div class="info-bar-fill" style="width:' + (risk || 0) +
          '%;background:' + riskColor + ';"></div></div>' +
          '<span style="font-size:11px;color:' + riskColor + ';">' + riskLabel + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';

    html += '<div class="info-section">' +
      '<h4>Capital Flow Indicators</h4>';

    var indicators = [
      ['listing_velocity', 'Listing Velocity'],
      ['price_trajectory', 'Price Trajectory'],
      ['rental_yield', 'Rental Yield'],
      ['investor_activity', 'Investor Activity'],
      ['dom_shift', 'DOM Shift'],
      ['flip_rate', 'Flip Rate'],
      ['affordability_cliff', 'Affordability'],
    ];

    indicators.forEach(function (item) {
      var key = item[0];
      var label = item[1];
      var def = CAPITAL_INDICATORS[key];
      var val = p[key];
      var formatted = def ? def.format(val) : (val != null ? val : 'N/A');
      var isActive = key === state.capitalIndicator;

      html += '<div class="info-row' + (isActive ? ' capital-active-indicator' : '') + '">' +
        '<span class="label">' + label + '</span>' +
        '<span class="value">' + formatted + '</span>' +
      '</div>';
    });

    html += '</div>';

    html += '<div class="info-section">' +
      '<h4>Socioeconomic Context</h4>' +
      '<div class="info-row"><span class="label">Median Income</span><span class="value">' +
        (p.median_household_income ? '$' + Math.round(p.median_household_income).toLocaleString() : 'N/A') + '</span></div>' +
      '<div class="info-row"><span class="label">Median Home Value</span><span class="value">' +
        (p.median_home_value ? '$' + Math.round(p.median_home_value).toLocaleString() : 'N/A') + '</span></div>' +
      '<div class="info-row"><span class="label">Median Rent</span><span class="value">' +
        (p.median_gross_rent ? '$' + Math.round(p.median_gross_rent).toLocaleString() + '/mo' : 'N/A') + '</span></div>' +
      '<div class="info-row"><span class="label">Renter Share</span><span class="value">' +
        (p.renter_pct != null ? p.renter_pct.toFixed(0) + '%' : 'N/A') + '</span></div>' +
      '<div class="info-row"><span class="label">Rent Burden</span><span class="value" style="color:' +
        (p.rent_burden_pct > 35 ? 'var(--danger)' : p.rent_burden_pct > 25 ? 'var(--warning)' : 'var(--text)') + '">' +
        (p.rent_burden_pct != null ? p.rent_burden_pct.toFixed(0) + '% of income' : 'N/A') + '</span></div>' +
      '<div class="info-row"><span class="label">Population</span><span class="value">' +
        (p.total_population ? Math.round(p.total_population).toLocaleString() : 'N/A') + '</span></div>' +
    '</div>';

    html += '<div class="info-section">' +
      '<h4>Indicator Profile</h4>' +
      '<div class="capital-spark">';

    var sparkIndicators = ['listing_velocity', 'price_trajectory', 'rental_yield', 'investor_activity', 'displacement_risk', 'flip_rate', 'affordability_cliff'];
    sparkIndicators.forEach(function (key) {
      var def = CAPITAL_INDICATORS[key];
      var val = p[key];
      var d = def.domain;
      var pctVal = val != null ? Math.max(0, Math.min(100, ((val - d[0]) / (d[d.length - 1] - d[0])) * 100)) : 0;
      var color = val != null ? def.scale.domain(d)(val).hex() : '#333';

      html += '<div class="capital-spark-bar">' +
        '<div class="capital-spark-fill" style="height:' + pctVal + '%;background:' + color + ';"></div>' +
        '<span class="capital-spark-label">' + def.label.substring(0, 3) + '</span>' +
      '</div>';
    });

    html += '</div></div>';

    if (p.is_sample_data) {
      html += '<div class="info-section"><p style="font-size:11px;color:var(--text-dim);font-style:italic;">Sample data for illustration. Run the data pipeline for real values.</p></div>';
    }

    return html;
  }

  function buildPoliticalInfo(p) {
    var partyColor = partyColors[p.party] || partyColors.Unknown;
    var partyName = p.party === 'D' ? 'Democrat' : p.party === 'R' ? 'Republican' : 'Unknown';
    var levelLabel = {
      federal: 'Federal',
      state: 'State',
      county: 'County',
      borough: 'Borough',
      city: 'City',
    }[p.level] || p.level;

    return '' +
      '<h3>' + p.name + '</h3>' +
      '<div class="info-section">' +
        '<h4>Representative</h4>' +
        '<div class="info-row"><span class="label">Name</span>' +
        '<span class="value">' + p.representative + '</span></div>' +
        '<div class="info-row"><span class="label">Party</span>' +
        '<span class="value" style="color:' + partyColor + ';font-weight:600;">' + partyName + '</span></div>' +
        '<div class="info-row"><span class="label">Level</span>' +
        '<span class="value">' + levelLabel + '</span></div>' +
        '<div class="info-row"><span class="label">District</span>' +
        '<span class="value">' + p.district_id + '</span></div>' +
      '</div>';
  }

  // ── Capital Indicator Selector ──────────────────────────────
  function initCapitalSelector() {
    var select = document.getElementById('capital-indicator-select');
    if (!select) return;

    select.addEventListener('change', function () {
      state.capitalIndicator = select.value;
      if (state.activeLayers.has('capital')) {
        buildCapitalLayer();
      }
    });
  }

  // ── Political District Type Selector ────────────────────────
  function initPoliticalSelector() {
    var select = document.getElementById('political-type-select');
    if (!select) return;

    select.addEventListener('change', function () {
      state.politicalType = select.value;
      if (state.activeLayers.has('political')) {
        buildPoliticalLayer();
      }
    });
  }

  // ── Timeline ───────────────────────────────────────────────
  var timelineSliderInstance = null;

  function rebuildTimeline(decadeMin) {
    var slider = document.getElementById('timeline-slider');
    var labelsContainer = document.getElementById('timeline-labels');

    // Destroy existing slider
    if (timelineSliderInstance) {
      timelineSliderInstance.destroy();
      timelineSliderInstance = null;
    }

    // Build decade labels
    var labelsHtml = '';
    for (var d = decadeMin; d <= 2020; d += 10) {
      labelsHtml += '<span data-decade="' + d + '">' + d + 's</span>';
    }
    labelsContainer.innerHTML = labelsHtml;

    // Create new slider
    noUiSlider.create(slider, {
      start: [2020],
      connect: [true, false],
      step: 10,
      range: {
        min: decadeMin,
        max: 2020,
      },
      format: {
        to: function (value) { return Math.round(value); },
        from: function (value) { return Number(value); },
      },
    });

    timelineSliderInstance = slider.noUiSlider;
    state.currentDecade = 2020;

    slider.noUiSlider.on('update', function (values) {
      var decade = parseInt(values[0]);
      if (decade !== state.currentDecade) {
        state.currentDecade = decade;
        onDecadeChange(decade);
      }
    });

    // Clickable decade labels
    labelsContainer.querySelectorAll('span').forEach(function (el) {
      el.addEventListener('click', function () {
        var decade = parseInt(el.getAttribute('data-decade'));
        slider.noUiSlider.set(decade);
      });
    });

    updateDecadeLabels(2020);
  }

  function onDecadeChange(decade) {
    document.getElementById('current-decade').textContent = decade + 's';
    updateDecadeLabels(decade);

    if (state.activeLayers.has('highways')) buildHighwayLayer();
    if (state.activeLayers.has('income')) buildIncomeLayer();
    if (state.activeLayers.has('race')) buildRaceLayer();
    if (state.activeLayers.has('pollution')) buildPollutionLayer();

    showNarrativeForDecade(decade);
  }

  function updateDecadeLabels(decade) {
    document.querySelectorAll('#timeline-labels span').forEach(function (el) {
      var d = parseInt(el.getAttribute('data-decade'));
      el.classList.toggle('active', d === decade);
    });
  }

  // ── Narrative Cards ────────────────────────────────────────
  function showNarrativeForDecade(decade) {
    var events = state.timelineEvents.filter(function (e) {
      var eventDecade = Math.floor(e.year / 10) * 10;
      return eventDecade === decade && !state.narrativeDismissed.has(e.year + ':' + e.title);
    });

    if (events.length === 0) {
      document.getElementById('narrative-card').classList.add('hidden');
      return;
    }

    var event = events[0];
    document.getElementById('narrative-year').textContent = event.year;
    document.getElementById('narrative-title').textContent = event.title;
    document.getElementById('narrative-text').textContent = event.description;
    document.getElementById('narrative-card').classList.remove('hidden');

    document.getElementById('narrative-card').dataset.eventKey = event.year + ':' + event.title;
  }

  // ── Layer Toggle Logic ─────────────────────────────────────
  function initLayerToggles() {
    document.querySelectorAll('.layer-toggle input').forEach(function (input) {
      input.addEventListener('change', function () {
        var layerName = input.getAttribute('data-layer');
        var group = input.closest('.layer-group');

        if (input.checked) {
          state.activeLayers.add(layerName);
          group.classList.add('active');
          rebuildLayer(layerName);
          state.layerGroups[layerName].addTo(state.map);
        } else {
          state.activeLayers.delete(layerName);
          group.classList.remove('active');
          if (state.map.hasLayer(state.layerGroups[layerName])) {
            state.map.removeLayer(state.layerGroups[layerName]);
          }
        }
      });
    });
  }

  // ── UI Event Handlers ──────────────────────────────────────
  function initUI() {
    document.getElementById('sidebar-toggle').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
    });

    document.getElementById('info-close').addEventListener('click', function () {
      document.getElementById('info-panel').classList.add('hidden');
    });

    document.getElementById('narrative-close').addEventListener('click', function () {
      var card = document.getElementById('narrative-card');
      var key = card.dataset.eventKey;
      if (key) state.narrativeDismissed.add(key);
      card.classList.add('hidden');
    });

    document.getElementById('about-link').addEventListener('click', function (e) {
      e.preventDefault();
      document.getElementById('about-modal').classList.remove('hidden');
    });
    document.getElementById('modal-close').addEventListener('click', function () {
      document.getElementById('about-modal').classList.add('hidden');
    });
    document.getElementById('about-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    state.map.on('click', function () {
      document.getElementById('info-panel').classList.add('hidden');
    });

    state.map.on('click', function () {
      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
      }
    });
  }

  // ── Loading Screen ─────────────────────────────────────────
  function showLoading() {
    var overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loading';
    overlay.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">Loading map data...</div>';
    document.body.appendChild(overlay);
  }

  function hideLoading() {
    var overlay = document.getElementById('loading');
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(function () { overlay.remove(); }, 600);
    }
  }

  // ── Tooltip CSS injection ──────────────────────────────────
  function injectTooltipStyles() {
    var style = document.createElement('style');
    style.textContent = '' +
      '.dark-tooltip { background: rgba(22,27,34,0.95) !important; color: #e6edf3 !important; ' +
      'border: 1px solid rgba(255,255,255,0.1) !important; border-radius: 6px !important; ' +
      'font-family: Inter, sans-serif !important; font-size: 12px !important; ' +
      'padding: 6px 10px !important; box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important; }' +
      '.dark-tooltip::before { border-top-color: rgba(22,27,34,0.95) !important; }';
    document.head.appendChild(style);
  }

  // ── Boot ───────────────────────────────────────────────────
  async function boot() {
    showLoading();
    injectTooltipStyles();
    initMap();

    await loadCityConfig();
    initCitySearch();
    initLayerToggles();
    initCapitalSelector();
    initPoliticalSelector();
    initUI();

    var defaultSlug = state.cityConfig.defaultCity;
    await switchCity(defaultSlug);

    hideLoading();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
