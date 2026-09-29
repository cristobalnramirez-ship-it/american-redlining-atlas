/* ============================================================
   American Redlining Atlas — app.js
   Multi-city map of HOLC redlining with current Census context.
   Every layer shown comes from a named public source; see About.
   ============================================================ */

(function () {
  'use strict';

  var ACS_LABEL = 'ACS 2018–22';
  var ALL_LAYERS = ['redlining', 'highways', 'income', 'race', 'floods', 'pollution', 'political'];
  var FILES = {
    redlining: 'redlining.geojson', highways: 'highways.geojson', income: 'income.geojson',
    race: 'race.geojson', floods: 'flood_zones.geojson', pollution: 'tri_sites.geojson',
    political: 'political.geojson',
  };

  // ── State ──────────────────────────────────────────────────
  var state = {
    currentDecade: 2020,
    activeLayers: new Set(),
    layerData: {},
    layerGroups: {},
    map: null,
    timelineEvents: [],
    narrative: { decade: null, index: 0, dismissed: new Set() },
    politicalType: 'congressional',
    currentCity: null,
    cityConfig: {},
    cityMeta: {},
    loadToken: 0,
  };

  // ── Colors ─────────────────────────────────────────────────
  var incomeScale = chroma.scale('viridis').domain([20000, 250000]);
  var NO_DATA = '#3a3f47';
  var partyColors = { D: '#3b82f6', R: '#ef4444', NP: '#a78bfa', Unknown: '#6b7280' };
  var partyNames = { D: 'Democrat', R: 'Republican', NP: 'Nonpartisan office', Unknown: 'Unknown' };
  var raceColors = { white: '#1b9e77', black: '#d95f02', hispanic: '#7570b3', asian: '#e7298a', diverse: '#9ca3af' };
  var holcColors = { A: '#4daf4a', B: '#377eb8', C: '#ffff33', D: '#e41a1c' };
  var HOLC_UNGRADED = '#8b8b8b';
  var holcLabels = { A: 'Best', B: 'Still Desirable', C: 'Definitely Declining', D: 'Hazardous' };
  var politicalTypeLabels = {
    congressional: 'U.S. House', state_senate: 'State Senate', state_assembly: 'State Assembly',
    state_house: 'State House', borough_president: 'Borough President',
    commissioner: 'County Commissioner', city_council: 'City Council',
  };

  // ── Helpers ────────────────────────────────────────────────
  function pct(v) { return v != null ? v.toFixed(1) + '%' : '—'; }
  function money(v) { return v != null ? '$' + Math.round(v).toLocaleString() : 'No data'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function link(url, text) {
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text || 'source') + '</a>';
  }
  function holcYearLabel() { return state.cityMeta.holcYear ? String(state.cityMeta.holcYear) : '1930s'; }
  function miCityUrl() {
    var c = state.cityMeta;
    var name = (c.holcCities && c.holcCities[0]) || c.label;
    return 'https://dsl.richmond.edu/panorama/redlining/map/' + encodeURIComponent(c.state) + '/' + encodeURIComponent(name);
  }

  function onClick(layer, fn) {
    layer.on('click', function (e) {
      L.DomEvent.stopPropagation(e); // otherwise the map's click handler closes the panel
      fn(e);
    });
  }

  function interiorPoint(layer) {
    var c = layer.getBounds().getCenter();
    var rings = [];
    (function collect(ll) {
      if (!ll.length) return;
      if (ll[0] instanceof L.LatLng) { rings.push(ll); return; }
      ll.forEach(collect);
    })(layer.getLatLngs());
    var y = c.lat, xs = [];
    rings.forEach(function (ring) {
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i], p = ring[j];
        if ((a.lat > y) !== (p.lat > y)) xs.push(a.lng + (y - a.lat) * (p.lng - a.lng) / (p.lat - a.lat));
      }
    });
    xs.sort(function (m, n) { return m - n; });
    var best = null, w = -1;
    for (var k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] > w) { w = xs[k + 1] - xs[k]; best = (xs[k] + xs[k + 1]) / 2; }
    }
    return best == null ? c : L.latLng(y, best);
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Map ────────────────────────────────────────────────────
  function initMap() {
    state.map = L.map('map', { center: [39.8283, -98.5795], zoom: 5 });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(state.map);
    state.map.attributionControl.addAttribution(
      'Redlining: <a href="https://dsl.richmond.edu/panorama/redlining/" target="_blank" rel="noopener">Mapping Inequality</a> (Nelson, Winling et al., CC BY-NC-SA)'
    );
    ALL_LAYERS.forEach(function (n) { state.layerGroups[n] = L.layerGroup(); });
  }

  // ── City search ────────────────────────────────────────────
  function initCitySearch() {
    var input = document.getElementById('city-search');
    var dropdown = document.getElementById('city-dropdown');
    var cities = state.cityConfig.cities;
    var slugs = Object.keys(cities).sort(function (a, b) {
      return (cities[a].label + cities[a].state).localeCompare(cities[b].label + cities[b].state);
    });
    var highlighted = -1;

    function options() { return dropdown.querySelectorAll('.city-option:not(.disabled)'); }
    function setHighlight(i) {
      var opts = options();
      opts.forEach(function (o) { o.classList.remove('highlighted'); });
      if (!opts.length) { highlighted = -1; return; }
      highlighted = (i + opts.length) % opts.length;
      opts[highlighted].classList.add('highlighted');
      opts[highlighted].scrollIntoView({ block: 'nearest' });
    }
    function choose(slug) {
      input.value = '';
      dropdown.classList.add('hidden');
      input.blur();
      switchCity(slug);
    }
    function render(filter) {
      var html = '', count = 0;
      slugs.forEach(function (slug) {
        var c = cities[slug];
        var label = c.label + ', ' + c.state;
        if (filter && label.toLowerCase().indexOf(filter.toLowerCase()) === -1) return;
        html += '<div class="city-option' + (slug === state.currentCity ? ' active' : '') + '" role="option" data-slug="' + slug + '">' +
          esc(label) + (c.featured ? ' <span class="city-featured" title="Featured city with extra layers">★</span>' : '') + '</div>';
        count++;
      });
      dropdown.innerHTML = count ? html : '<div class="city-option disabled">No cities found</div>';
      dropdown.classList.remove('hidden');
      highlighted = -1;
      options().forEach(function (el) {
        el.addEventListener('click', function () { choose(el.getAttribute('data-slug')); });
      });
    }

    input.addEventListener('focus', function () { render(input.value); });
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(highlighted + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(highlighted - 1); }
      else if (e.key === 'Enter') {
        var opts = options();
        var el = opts[highlighted >= 0 ? highlighted : 0];
        if (el) { e.preventDefault(); choose(el.getAttribute('data-slug')); }
      } else if (e.key === 'Escape') { dropdown.classList.add('hidden'); input.blur(); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.city-selector')) dropdown.classList.add('hidden');
    });
  }

  // ── Switch city ────────────────────────────────────────────
  function switchCity(slug) {
    var config = state.cityConfig.cities[slug];
    if (!config) return Promise.resolve();
    var token = ++state.loadToken;
    showLoading();

    state.currentCity = slug;
    state.cityMeta = config;
    if (location.hash.slice(1) !== slug) history.replaceState(null, '', '#' + slug);
    ALL_LAYERS.forEach(function (name) {
      if (state.map.hasLayer(state.layerGroups[name])) state.map.removeLayer(state.layerGroups[name]);
      state.layerGroups[name] = L.layerGroup();
    });
    state.layerData = {};
    state.activeLayers = new Set();
    state.narrative = { decade: null, index: 0, dismissed: new Set() };
    state.timelineEvents = [];
    state.politicalType = config.politicalTypes ? config.politicalTypes[0] : 'congressional';
    document.getElementById('info-panel').classList.add('hidden');
    document.getElementById('narrative-card').classList.add('hidden');

    document.getElementById('atlas-title').textContent = config.label + ', ' + config.state;
    document.title = config.label + ', ' + config.state + ' — American Redlining Atlas';
    document.getElementById('holc-year-label').textContent = '(' + holcYearLabel() + ')';
    document.getElementById('about-city-text').textContent = config.about || '';

    var timelineOn = !!config.decadeMin;
    document.body.classList.toggle('no-timeline', !timelineOn);
    state.map.invalidateSize();
    state.map.setView(config.center, config.zoom);
    document.getElementById('city-subtitle').textContent = timelineOn
      ? 'Layers of Spatial History, ' + config.decadeMin + 's–2020s'
      : 'HOLC redlining and today’s Census data';

    var polSelect = document.getElementById('political-type-select');
    polSelect.innerHTML = '';
    (config.politicalTypes || []).forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t;
      opt.textContent = politicalTypeLabels[t] || t;
      polSelect.appendChild(opt);
    });
    polSelect.value = state.politicalType;

    document.querySelectorAll('.layer-toggle input').forEach(function (input) {
      input.checked = false;
      input.closest('.layer-group').classList.remove('active');
    });
    ALL_LAYERS.forEach(function (layer) {
      document.getElementById('group-' + layer).classList.toggle('hidden-layer-group', config.layers.indexOf(layer) < 0);
    });

    if (timelineOn) rebuildTimeline(config.decadeMin);
    state.currentDecade = 2020;
    document.getElementById('current-decade').textContent = '2020s';

    return loadAllData(slug, token).then(function () {
      if (token !== state.loadToken) return; // a newer city switch superseded this one
      // Hide any layer whose file turned out empty
      ALL_LAYERS.forEach(function (layer) {
        var d = state.layerData[layer];
        if (config.layers.indexOf(layer) >= 0 && !(d && d.features && d.features.length)) {
          document.getElementById('group-' + layer).classList.add('hidden-layer-group');
        }
      });
      updateRedliningLegend();
      var red = document.getElementById('layer-redlining');
      if (state.layerData.redlining) {
        red.checked = true;
        red.dispatchEvent(new Event('change'));
      }
      if (timelineOn) showNarrativeForDecade(state.currentDecade);
      hideLoading();
    });
  }

  function loadAllData(slug, token) {
    var base = 'data/cities/' + slug + '/';
    var layers = state.cityMeta.layers;
    var loads = layers.filter(function (l) { return FILES[l]; }).map(function (l) {
      return getJSON(base + FILES[l]).then(function (d) { if (token === state.loadToken) state.layerData[l] = d; });
    });
    if (state.cityMeta.decadeMin) {
      loads.push(getJSON(base + 'timeline.json').then(function (d) { if (token === state.loadToken) state.timelineEvents = d; }));
    }
    return Promise.allSettled(loads).then(function (results) {
      results.forEach(function (r) { if (r.status === 'rejected') console.warn('Layer not loaded:', r.reason.message); });
    });
  }

  function updateRedliningLegend() {
    var d = state.layerData.redlining;
    var graded = d && d.features.some(function (f) { return f.properties.grade; });
    var ungraded = d && d.features.some(function (f) { return !f.properties.grade; });
    document.getElementById('legend-redlining-grades').classList.toggle('hidden', !graded);
    document.getElementById('legend-redlining-ungraded').classList.toggle('hidden', !ungraded);
    document.getElementById('legend-redlining-nonsurvey').classList.toggle('hidden', !!state.cityMeta.citySurvey);
  }

  // ── Layers ─────────────────────────────────────────────────
  function buildRedliningLayer() {
    var group = state.layerGroups.redlining;
    group.clearLayers();
    var data = state.layerData.redlining;
    if (!data) return;
    L.geoJSON(data, {
      style: function (f) {
        var c = holcColors[f.properties.grade] || HOLC_UNGRADED;
        return { fillColor: c, fillOpacity: 0.35, color: c, weight: 1.5, opacity: 0.8 };
      },
      onEachFeature: function (f, layer) {
        onClick(layer, function () { showInfoPanel(f, 'redlining'); });
        layer.on('mouseover', function () { layer.setStyle({ fillOpacity: 0.55, weight: 2.5 }); });
        layer.on('mouseout', function () { layer.setStyle({ fillOpacity: 0.35, weight: 1.5 }); });
      },
    }).addTo(group);
  }

  function highwayStatus(p, decade) {
    var opened = p.open_year || p.construction_year;
    if (!opened) return 'open';
    var o = Math.floor(opened / 10) * 10;
    var done = p.completion_year ? Math.floor(p.completion_year / 10) * 10 : o;
    if (decade < o) return 'hidden';
    return decade < done ? 'building' : 'open';
  }

  function buildHighwayLayer() {
    var group = state.layerGroups.highways;
    group.clearLayers();
    var data = state.layerData.highways;
    if (!data) return;
    var decade = state.cityMeta.decadeMin ? state.currentDecade : 2020;
    data.features.forEach(function (feature) {
      var p = feature.properties;
      var status = highwayStatus(p, decade);
      if (status === 'hidden') return;
      L.geoJSON(feature, {
        style: { color: '#ff8c00', weight: 3, opacity: status === 'open' ? 0.9 : 0.6, dashArray: status === 'building' ? '8 6' : null },
        onEachFeature: function (feat, layer) { onClick(layer, function () { showInfoPanel(feat, 'highways'); }); },
      }).addTo(group);
      var at = p.label_at;
      if (!at) {
        var line = feature.geometry.type === 'MultiLineString'
          ? feature.geometry.coordinates.reduce(function (a, b) { return b.length > a.length ? b : a; })
          : feature.geometry.coordinates;
        at = line[Math.floor(line.length / 2)];
      }
      if (at) {
        L.marker([at[1], at[0]], {
          icon: L.divIcon({ className: 'highway-label', html: '<span>' + esc(p.designation) + '</span>', iconSize: null }),
          interactive: false,
        }).addTo(group);
      }
    });
  }

  function buildIncomeLayer() {
    var group = state.layerGroups.income;
    group.clearLayers();
    var data = state.layerData.income;
    if (!data) return;
    L.geoJSON(data, {
      style: function (f) {
        var v = f.properties.income_2020;
        return { fillColor: v != null ? incomeScale(v).hex() : NO_DATA, fillOpacity: 0.6, color: 'rgba(255,255,255,0.15)', weight: 1 };
      },
      onEachFeature: function (f, layer) {
        onClick(layer, function () { showInfoPanel(f, 'income'); });
        layer.bindTooltip(function () {
          return '<strong>' + esc(f.properties.name || f.properties.tract_id) + '</strong><br>Median income: ' + money(f.properties.income_2020);
        }, { sticky: true, className: 'dark-tooltip' });
        layer.on('mouseover', function () { layer.setStyle({ fillOpacity: 0.8, weight: 2, color: 'rgba(255,255,255,0.4)' }); });
        layer.on('mouseout', function () { layer.setStyle({ fillOpacity: 0.6, weight: 1, color: 'rgba(255,255,255,0.15)' }); });
      },
    }).addTo(group);
  }

  function dominantGroup(p) {
    var vals = { white: p.pct_white_2020, black: p.pct_black_2020, hispanic: p.pct_hispanic_2020, asian: p.pct_asian_2020 };
    if (vals.white == null) return null;
    var best = null, max = -1, tie = false;
    Object.keys(vals).forEach(function (k) {
      var v = vals[k] || 0;
      if (v > max) { max = v; best = k; tie = false; } else if (v === max) { tie = true; }
    });
    return max > 50 && !tie ? best : 'diverse';
  }

  function buildRaceLayer() {
    var group = state.layerGroups.race;
    group.clearLayers();
    var data = state.layerData.race;
    if (!data) return;
    L.geoJSON(data, {
      style: function (f) {
        var d = dominantGroup(f.properties);
        return { fillColor: d ? raceColors[d] : NO_DATA, fillOpacity: 0.5, color: 'rgba(255,255,255,0.1)', weight: 1 };
      },
      onEachFeature: function (f, layer) {
        onClick(layer, function () { showInfoPanel(f, 'race'); });
        layer.bindTooltip(function () {
          var p = f.properties;
          return '<strong>' + esc(p.name || p.tract_id) + '</strong><br>White ' + pct(p.pct_white_2020) +
            ' · Black ' + pct(p.pct_black_2020) + ' · Hispanic ' + pct(p.pct_hispanic_2020) + ' · Asian ' + pct(p.pct_asian_2020);
        }, { sticky: true, className: 'dark-tooltip' });
        layer.on('mouseover', function () { layer.setStyle({ fillOpacity: 0.75, weight: 2, color: 'rgba(255,255,255,0.3)' }); });
        layer.on('mouseout', function () { layer.setStyle({ fillOpacity: 0.5, weight: 1, color: 'rgba(255,255,255,0.1)' }); });
      },
    }).addTo(group);
  }

  function floodStyle(p) {
    var moderate = p.flood_risk === 'moderate';
    return { fillColor: p.flood_risk === 'coastal' ? '#0066cc' : '#0064ff', fillOpacity: moderate ? 0.12 : 0.35,
      color: '#0088ff', weight: moderate ? 0.5 : 1, opacity: 0.5 };
  }

  function buildFloodLayer() {
    var group = state.layerGroups.floods;
    group.clearLayers();
    var data = state.layerData.floods;
    if (!data) return;
    L.geoJSON(data, {
      style: function (f) { return floodStyle(f.properties); },
      onEachFeature: function (f, layer) {
        onClick(layer, function () { showInfoPanel(f, 'floods'); });
        layer.on('mouseover', function () { layer.setStyle({ fillOpacity: 0.55, weight: 2 }); });
        layer.on('mouseout', function () { layer.setStyle(floodStyle(f.properties)); });
      },
    }).addTo(group);
  }

  function buildPollutionLayer() {
    var group = state.layerGroups.pollution;
    group.clearLayers();
    var data = state.layerData.pollution;
    if (!data) return;
    data.features.forEach(function (f) {
      var c = f.geometry.coordinates;
      var m = L.circleMarker([c[1], c[0]], { radius: 5, fillColor: '#ff8c00', fillOpacity: 0.8, color: '#ffb366', weight: 1 });
      onClick(m, function () { showInfoPanel(f, 'pollution'); });
      m.bindTooltip(esc(f.properties.facility_name || 'TRI facility'), { className: 'dark-tooltip' });
      m.addTo(group);
    });
  }

  function buildPoliticalLayer() {
    var group = state.layerGroups.political;
    group.clearLayers();
    var data = state.layerData.political;
    if (!data) return;
    var filtered = { type: 'FeatureCollection', features: data.features.filter(function (f) {
      return f.properties.district_type === state.politicalType;
    }) };
    L.geoJSON(filtered, {
      style: function (f) {
        var c = partyColors[f.properties.party] || partyColors.Unknown;
        return { fillColor: c, fillOpacity: 0.08, color: c, weight: 3, opacity: 0.9, dashArray: '6 4' };
      },
      onEachFeature: function (f, layer) {
        var p = f.properties;
        var c = partyColors[p.party] || partyColors.Unknown;
        L.marker(interiorPoint(layer), {
          icon: L.divIcon({ className: 'political-label',
            html: '<span style="color:' + c + ';border-color:' + c + '">' + esc(p.district_number || p.district_id) + '</span>', iconSize: null }),
          interactive: false,
        }).addTo(group);
        onClick(layer, function () { showInfoPanel(f, 'political'); });
        layer.bindTooltip('<strong>' + esc(p.name) + '</strong><br><span style="color:' + c + '">' + esc(p.representative) +
          (p.party === 'D' || p.party === 'R' ? ' (' + p.party + ')' : '') + '</span>', { sticky: true, className: 'dark-tooltip' });
        layer.on('mouseover', function () { layer.setStyle({ fillOpacity: 0.25, weight: 4, dashArray: null }); });
        layer.on('mouseout', function () { layer.setStyle({ fillOpacity: 0.08, weight: 3, dashArray: '6 4' }); });
      },
    }).addTo(group);
  }

  var builders = {
    redlining: buildRedliningLayer, highways: buildHighwayLayer, income: buildIncomeLayer, race: buildRaceLayer,
    floods: buildFloodLayer, pollution: buildPollutionLayer, political: buildPoliticalLayer,
  };

  // ── Info panel ─────────────────────────────────────────────
  function section(title, body) {
    return '<div class="info-section">' + (title ? '<h4>' + title + '</h4>' : '') + body + '</div>';
  }
  function row(label, value, style) {
    return '<div class="info-row"><span class="label">' + label + '</span><span class="value"' +
      (style ? ' style="' + style + '"' : '') + '>' + value + '</span></div>';
  }
  function note(text) { return '<p class="info-note">' + text + '</p>'; }

  var infoBuilders = {
    redlining: function (p) {
      var g = p.grade;
      var gradeText = g ? g + ' — “' + holcLabels[g] + '”' : esc(p.cat || 'Not graded');
      var title = p.label && p.label !== p.cat ? 'HOLC area ' + esc(p.label) : 'HOLC area';
      return '<h3>' + title + '</h3>' +
        section('HOLC map (<span class="nocaps">' + holcYearLabel() + '</span>)', row(g ? 'Grade' : 'Category', gradeText, 'color:' + (holcColors[g] || HOLC_UNGRADED))) +
        section('', note((p.city_survey === false ? 'This map was not part of HOLC’s standard City Survey, so it uses its own categories. ' : '') +
          'Area descriptions and the original map scan are on ' + link(miCityUrl(), 'Mapping Inequality') + '.'));
    },
    highways: function (p) {
      var dates = [];
      if (p.construction_year) dates.push(row('Construction began', p.construction_year));
      if (p.open_year) dates.push(row('First section opened', p.open_year));
      if (p.completion_year) dates.push(row('Completed', p.completion_year));
      var src = (p.sources || []).map(function (u, i) { return link(u, 'source ' + (i + 1)); }).join(' · ');
      return '<h3>' + esc(p.name) + '</h3>' +
        section('Construction', row('Route', esc(p.designation)) + dates.join('')) +
        (p.neighborhoods_displaced && p.neighborhoods_displaced.length
          ? section('Neighborhoods cut or displaced', '<p class="info-danger">' + p.neighborhoods_displaced.map(esc).join(', ') + '</p>') : '') +
        section('', '<p class="info-text">' + esc(p.description) + '</p>' + (src ? note(src) : ''));
    },
    income: function (p) {
      var pov = p.poverty_rate_2020;
      return '<h3>' + esc(p.name || p.tract_id) + '</h3>' +
        section('Median household income (' + ACS_LABEL + ')', row('Income', money(p.income_2020))) +
        section('Poverty rate (' + ACS_LABEL + ')', row('Rate', pct(pov)) +
          (pov != null ? '<div class="info-bar"><div class="info-bar-fill" style="width:' + Math.min(100, pov) + '%;background:' +
            (pov > 30 ? 'var(--danger)' : pov > 15 ? 'var(--warning)' : 'var(--success)') + ';"></div></div>' : '')) +
        section('', note('U.S. Census Bureau, American Community Survey 5-year estimates. “No data” means the estimate was suppressed or unreliable.'));
    },
    race: function (p) {
      var groups = [['white', 'White'], ['black', 'Black'], ['hispanic', 'Hispanic or Latino'], ['asian', 'Asian']];
      var bars = groups.map(function (g) {
        var v = p['pct_' + g[0] + '_2020'];
        return '<div style="margin:4px 0;">' + row(g[1], pct(v)) +
          '<div class="info-bar"><div class="info-bar-fill" style="width:' + (v || 0) + '%;background:' + raceColors[g[0]] + ';"></div></div></div>';
      }).join('');
      return '<h3>' + esc(p.name || p.tract_id) + '</h3>' + section('Race and ethnicity (' + ACS_LABEL + ')', bars) +
        section('', note('White, Black and Asian are non-Hispanic. Census Bureau ACS 5-year estimates.'));
    },
    floods: function (p) {
      return '<h3>FEMA flood zone ' + esc(p.zone || '') + '</h3>' +
        section('Classification', row('Zone', esc(p.zone || '')) +
          row('Risk', esc(p.flood_risk || 'unknown'), 'color:' + (p.flood_risk === 'moderate' ? 'var(--warning)' : 'var(--danger)'))) +
        section('', '<p class="info-text">' + esc(p.zone_description || '') + '</p>' +
          note('FEMA National Flood Hazard Layer extract. For an official determination use the ' +
            link('https://msc.fema.gov/portal/home', 'FEMA Flood Map Service Center') + '.'));
    },
    pollution: function (p) {
      return '<h3>' + esc(p.facility_name || 'TRI facility') + '</h3>' +
        section('EPA Toxics Release Inventory', row('Industry', esc(p.industry || '—')) + row('TRI ID', esc(p.tri_facility_id || '—'))) +
        section('', note('Facility registered in EPA’s Toxics Release Inventory. Release amounts and chemicals are not loaded on this map; look the facility up in ' +
          link('https://enviro.epa.gov/triexplorer/', 'TRI Explorer') + '.'));
    },
    political: function (p) {
      var c = partyColors[p.party] || partyColors.Unknown;
      return '<h3>' + esc(p.name) + '</h3>' +
        section('Officeholder', row('Name', esc(p.representative)) +
          row('Party', partyNames[p.party] || 'Unknown', 'color:' + c + ';font-weight:600;') + row('District', esc(p.district_id))) +
        section('', note((p.party === 'NP' ? 'Municipal elections here are nonpartisan. ' : '') + 'Officeholders as of ' + esc(p.as_of || '—') + '.'));
    },
  };

  function showInfoPanel(feature, type) {
    document.getElementById('info-content').innerHTML = infoBuilders[type](feature.properties);
    document.getElementById('info-panel').classList.remove('hidden');
  }

  // ── Timeline (featured cities only) ────────────────────────
  var slider = null;
  function rebuildTimeline(decadeMin) {
    var el = document.getElementById('timeline-slider');
    var labels = document.getElementById('timeline-labels');
    if (slider) { slider.destroy(); slider = null; }
    var html = '';
    for (var d = decadeMin; d <= 2020; d += 10) html += '<span data-decade="' + d + '">' + d + 's</span>';
    labels.innerHTML = html;
    noUiSlider.create(el, {
      start: [2020], connect: [true, false], step: 10, range: { min: decadeMin, max: 2020 },
      format: { to: function (v) { return Math.round(v); }, from: Number },
    });
    slider = el.noUiSlider;
    state.currentDecade = 2020;
    slider.on('update', function (values) {
      var decade = parseInt(values[0], 10);
      if (decade !== state.currentDecade) { state.currentDecade = decade; onDecadeChange(decade); }
    });
    labels.querySelectorAll('span').forEach(function (s) {
      s.addEventListener('click', function () { slider.set(parseInt(s.getAttribute('data-decade'), 10)); });
    });
    updateDecadeLabels(2020);
  }

  function onDecadeChange(decade) {
    document.getElementById('current-decade').textContent = decade + 's';
    updateDecadeLabels(decade);
    if (state.activeLayers.has('highways')) buildHighwayLayer();
    showNarrativeForDecade(decade);
  }

  function updateDecadeLabels(decade) {
    document.querySelectorAll('#timeline-labels span').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.getAttribute('data-decade'), 10) === decade);
    });
  }

  function eventsForDecade(decade) {
    return state.timelineEvents.filter(function (e) { return Math.floor(e.year / 10) * 10 === decade; });
  }
  function showNarrativeForDecade(decade) {
    state.narrative.decade = decade;
    state.narrative.index = 0;
    renderNarrative();
  }
  function renderNarrative() {
    var card = document.getElementById('narrative-card');
    var n = state.narrative;
    var events = eventsForDecade(n.decade);
    if (!events.length || n.dismissed.has(n.decade)) { card.classList.add('hidden'); return; }
    var e = events[n.index];
    document.getElementById('narrative-year').textContent = e.year;
    document.getElementById('narrative-title').textContent = e.title;
    document.getElementById('narrative-text').textContent = e.description;
    var srcs = [].concat(e.source || []);
    document.getElementById('narrative-source').innerHTML = srcs.map(function (u, i) {
      return link(u, srcs.length > 1 ? 'Source ' + (i + 1) : 'Source');
    }).join(' · ');
    document.getElementById('narrative-nav').classList.toggle('hidden', events.length < 2);
    document.getElementById('narrative-count').textContent = (n.index + 1) + ' of ' + events.length;
    document.getElementById('narrative-prev').disabled = n.index === 0;
    document.getElementById('narrative-next').disabled = n.index === events.length - 1;
    card.classList.remove('hidden');
  }
  function initNarrative() {
    document.getElementById('narrative-prev').addEventListener('click', function () {
      if (state.narrative.index > 0) { state.narrative.index--; renderNarrative(); }
    });
    document.getElementById('narrative-next').addEventListener('click', function () {
      if (state.narrative.index < eventsForDecade(state.narrative.decade).length - 1) { state.narrative.index++; renderNarrative(); }
    });
    document.getElementById('narrative-close').addEventListener('click', function () {
      state.narrative.dismissed.add(state.narrative.decade);
      document.getElementById('narrative-card').classList.add('hidden');
    });
  }

  // ── Controls ───────────────────────────────────────────────
  function initLayerToggles() {
    document.querySelectorAll('.layer-toggle input').forEach(function (input) {
      input.addEventListener('change', function () {
        var name = input.getAttribute('data-layer');
        var group = input.closest('.layer-group');
        if (input.checked) {
          state.activeLayers.add(name);
          group.classList.add('active');
          builders[name]();
          state.layerGroups[name].addTo(state.map);
        } else {
          state.activeLayers.delete(name);
          group.classList.remove('active');
          document.getElementById('info-panel').classList.add('hidden');
          if (state.map.hasLayer(state.layerGroups[name])) state.map.removeLayer(state.layerGroups[name]);
        }
      });
    });
  }

  function initPoliticalSelector() {
    var select = document.getElementById('political-type-select');
    select.addEventListener('change', function () {
      state.politicalType = select.value;
      if (state.activeLayers.has('political')) buildPoliticalLayer();
    });
  }

  function initUI() {
    document.getElementById('sidebar-toggle').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
    });
    document.getElementById('info-close').addEventListener('click', function () {
      document.getElementById('info-panel').classList.add('hidden');
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
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.getElementById('about-modal').classList.add('hidden');
        document.getElementById('info-panel').classList.add('hidden');
      }
    });
    state.map.on('click', function () {
      document.getElementById('info-panel').classList.add('hidden');
      if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
    });
  }

  function showLoading() {
    if (document.getElementById('loading')) return;
    var o = document.createElement('div');
    o.className = 'loading-overlay';
    o.id = 'loading';
    o.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">Loading map data…</div>';
    document.body.appendChild(o);
  }
  function hideLoading() {
    var o = document.getElementById('loading');
    if (o) { o.id = ''; o.classList.add('fade-out'); setTimeout(function () { o.remove(); }, 600); }
  }

  function initLegends() {
    var stops = [];
    for (var i = 0; i <= 8; i++) stops.push(incomeScale(20000 + 230000 * i / 8).hex());
    document.getElementById('income-gradient').style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';
  }

  // ── Boot ───────────────────────────────────────────────────
  function boot() {
    if (location.protocol === 'file:') {
      document.body.insertAdjacentHTML('beforeend',
        '<div class="file-warning">This atlas loads its data with fetch(), which browsers block for files opened directly. ' +
        'Run <code>python -m http.server 8000</code> in this folder and open <code>http://localhost:8000</code>.</div>');
    }
    showLoading();
    initMap();
    initLegends();
    getJSON('data/cities.json').then(function (cfg) {
      state.cityConfig = cfg;
      initCitySearch();
      initLayerToggles();
      initPoliticalSelector();
      initNarrative();
      initUI();
      var fromHash = decodeURIComponent(location.hash.slice(1));
      return switchCity(cfg.cities[fromHash] ? fromHash : cfg.defaultCity);
    });
    window.addEventListener('hashchange', function () {
      var slug = decodeURIComponent(location.hash.slice(1));
      if (state.cityConfig.cities && state.cityConfig.cities[slug] && slug !== state.currentCity) switchCity(slug);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
