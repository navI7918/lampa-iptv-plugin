(function () {
    'use strict';

    // Хранилище для настроек в памяти Lampa
    Lampa.Storage.set('iptv_playlist_url', Lampa.Storage.get('iptv_playlist_url', ''));
    Lampa.Storage.set('iptv_epg_url', Lampa.Storage.get('iptv_epg_url', ''));

    // --- МОДУЛЬ ПАРСИНГА M3U ---
    function parseM3U(data) {
        var lines = data.split('\n');
        var channelsByGroup = {};
        var currentChannel = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();

            if (line.indexOf('#EXTINF:') === 0) {
                currentChannel = {};
                var groupMatch = line.match(/group-title="([^"]+)"/i);
                var logoMatch = line.match(/tvg-logo="([^"]+)"/i);
                var idMatch = line.match(/tvg-id="([^"]+)"/i) || line.match(/epg-id="([^"]+)"/i);
                var nameIndex = line.lastIndexOf(',');
                var name = nameIndex !== -1 ? line.substring(nameIndex + 1).trim() : 'Без названия';

                currentChannel.name = name;
                currentChannel.group = groupMatch ? groupMatch[1] : 'Разное';
                currentChannel.logo = logoMatch ? logoMatch[1] : '';
                currentChannel.epg_id = idMatch ? idMatch[1] : '';
            } else if (line && line.indexOf('#') !== 0 && currentChannel) {
                currentChannel.url = line;
                if (!channelsByGroup[currentChannel.group]) {
                    channelsByGroup[currentChannel.group] = [];
                }
                channelsByGroup[currentChannel.group].push(currentChannel);
                currentChannel = null;
            }
        }
        return channelsByGroup;
    }

    function loadPlaylist(callback) {
        var url = Lampa.Storage.get('iptv_playlist_url');
        if (!url) {
            Lampa.Noty.show('Пожалуйста, укажите ссылку на плейлист в настройках.');
            callback(null);
            return;
        }
        fetch(url)
            .then(function(res) { if (!res.ok) throw new Error(); return res.text(); })
            .then(function(data) { callback(parseM3U(data)); })
            .catch(function() {
                Lampa.Noty.show('Не удалось загрузить плейлист. Проверьте URL.');
                callback(null);
            });
    }

    // --- МОДУЛЬ ОНЛАЙН EPG (XMLTV) ---
    var IPTV_EPG = {
        xmlData: '',
        isLoading: false,

        load: function(callback) {
            var url = Lampa.Storage.get('iptv_epg_url');
            if (!url) return callback(false);
            if (this.xmlData) return callback(true);

            this.isLoading = true;
            var self = this;

            fetch(url)
                .then(function(res) { return res.text(); })
                .then(function(text) {
                    self.xmlData = text;
                    self.isLoading = false;
                    callback(true);
                })
                .catch(function() {
                    self.isLoading = false;
                    callback(false);
                });
        },

        getProgram: function(epg_id) {
            if (!this.xmlData || !epg_id) return 'Нет программы';
            var escapedId = epg_id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            var regex = new RegExp('<programme[^>]*channel="' + escapedId + '"[^>]*>([\\s\\S]*?)</programme>', 'g');
            var match;
            var nowStr = this.formatDateToXmltv(new Date());

            while ((match = regex.exec(this.xmlData)) !== null) {
                var block = match[1];
                var startMatch = match[0].match(/start="(\d{14})/);
                var stopMatch = match[0].match(/stop="(\d{14})/);
                
                if (startMatch && stopMatch) {
                    if (nowStr >= startMatch[1] && nowStr <= stopMatch[1]) {
                        var titleMatch = block.match(/<title[^>]*>([^<]+)<\/title>/);
                        if (titleMatch) return titleMatch[1];
                    }
                }
            }
            return 'Нет текущей передачи';
        },

        formatDateToXmltv: function(date) {
            var pad = function(num) { return (num < 10 ? '0' : '') + num; };
            return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
        }
    };

    // --- ИНИЦИАЛИЗАЦИЯ И ИНТЕРФЕЙС LAMPA ---
    function startPlugin() {
        if (window.lampa_started) init();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type == 'ready') init();
            });
        }
    }

    function init() {
        // Добавляем пункт в главное левое меню
        Lampa.Listener.follow('menu', function (e) {
            if (e.type == 'ready') {
                var menu_item = {
                    id: 'my_iptv',
                    title: 'Мой IPTV',
                    icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://w3.org"><path d="M21 6H3C1.9 6 1 6.9 1 8V18C1 19.1 1.9 20 3 20H21C22.1 20 23 19.1 23 18V8C23 6.9 22.1 6 21 6Z" stroke="currentColor" stroke-width="2"/><path d="M17 2L12 6L7 2" stroke="currentColor" stroke-width="2"/></svg>',
                    description: 'Просмотр IPTV каналов'
                };
                e.object.items.splice(e.object.items.length - 1, 0, menu_item);
            }
        });

        // Компонент экрана IPTV
        Lampa.Component.add('my_iptv', function (object, components) {
            var scroll, html, active_group = '', playlist_data = null;

            return {
                create: function () {
                    html = $('<div class="iptv-wrapper layer--main"></div>');
                    scroll = new Lampa.Scroll({ mask: true, over: true, horizontal: false });
                    html.append(scroll.render());
                    return html;
                },
                render: function () {
                    var self = this;
                    this.activity.loader(true);

                    loadPlaylist(function(data) {
                        self.activity.loader(false);
                        if (!data || Object.keys(data).length === 0) {
                            scroll.append($('<div class="empty" style="text-align:center;padding:40px;">Плейлист пуст. Проверьте настройки.</div>'));
                            return;
                        }
                        playlist_data = data;
                        active_group = Object.keys(playlist_data)[0];
                        
                        self.buildMenu();
                        self.buildChannels();
                        self.startNavigation();
                    });
                    return html;
                },
                buildMenu: function() {
                    var self = this;
                    var menu = $('<div class="iptv-menu selector" style="margin:20px; padding:15px; background:rgba(255,255,255,0.1); border-radius:8px; text-align:center; font-size:1.4M;">Категория: <span class="active-group-name" style="font-weight:bold; color:#ffeb3b;">' + active_group + '</span></div>');
                    
                    menu.on('hover:enter', function() {
                        var items = [];
                        Object.keys(playlist_data).forEach(function(g) { items.push({ title: g, group: g }); });

                        Lampa.Select.show({
                            title: 'Выберите категорию',
                            items: items,
                            onSelect: function(item) {
                                active_group = item.group;
                                menu.find('.active-group-name').text(active_group);
                                self.buildChannels();
                                self.startNavigation();
                            },
                            onBack: function() { Lampa.Controller.toggle('my_iptv_controller'); }
                        });
                    });
                    scroll.append(menu);
                },
                buildChannels: function() {
                    var self = this;
                    scroll.render().find('.iptv-channels-list').remove();
                    var list = $('<div class="iptv-channels-list" style="display:flex; flex-direction:column; gap:10px; padding:20px;"></div>');
                    var channels = playlist_data[active_group] || [];

                    IPTV_EPG.load(function(success) {
                        channels.forEach(function(channel) {
                            var currentProgram = success ? IPTV_EPG.getProgram(channel.epg_id) : 'Программа недоступна';
                            var item = $('<div class="iptv-channel-item selector" style="display:flex; align-items:center; padding:15px; background:rgba(255,255,255,0.05); border-radius:6px;">' +
                                (channel.logo ? '<img src="' + channel.logo + '" style="width:50px; height:50px; object-fit:contain; margin-right:20px;" onerror="this.style.display=\'none\'" />' : '') +
                                '<div style="flex-grow:1;">' +
                                    '<div style="font-size:1.3M; font-weight:500;">' + channel.name + '</div>' +
                                    '<div style="font-size:0.9M; color:#ffeb3b; margin-top:5px;">' + currentProgram + '</div>' +
                                '</div>' +
                            '</div>');

                            item.on('hover:enter', function() {
                                Lampa.Player.play({ url: channel.url, title: channel.name, description: currentProgram });
                                Lampa.Player.playlist([{ title: channel.name, url: channel.url }]);
                            });
                            list.append(item);
                        });
                        Lampa.Controller.enable('my_iptv_controller');
});scroll.append(list);},startNavigation: function() {Lampa.Controller.add('my_iptv_controller', {toggle: function () { Lampa.Controller.collectionSet(scroll.render()); },left: function () { Lampa.Controller.toggle('menu'); },up: function () { Lampa.Navigator.move('up'); },down: function () { Lampa.Navigator.move('down'); },back: function () { Lampa.Controller.toggle('menu'); }});Lampa.Controller.toggle('my_iptv_controller');},destroy: function () { scroll.destroy(); html.remove(); }};});// Настройки плагинаLampa.Settings.listener.follow('open', function (e) {if (e.name == 'main') {var field = $('Настройки IPTVПлейлист и EPG');field.on('hover:enter', function () { openIptvSettings(); });e.body.find('[data-name="plugins"]').before(field);}});}function openIptvSettings() {var body = $('');var item_playlist = $('M3U плейлист' + (Lampa.Storage.get('iptv_playlist_url') || 'Не указана') + '');var item_epg = $('XMLTV (EPG)' + (Lampa.Storage.get('iptv_epg_url') || 'Не указана') + '');item_playlist.on('hover:enter', function() {Lampa.Input.edit({ value: Lampa.Storage.get('iptv_playlist_url'), title: 'URL M3U' }, function(url) {if(url) { Lampa.Storage.set('iptv_playlist_url', url); item_playlist.find('.settings-param__value').text(url); }});});item_epg.on('hover:enter', function() {Lampa.Input.edit({ value: Lampa.Storage.get('iptv_epg_url'), title: 'URL EPG' }, function(url) {if(url) { Lampa.Storage.set('iptv_epg_url', url); item_epg.find('.settings-param__value').text(url); }});});body.append(item_playlist).append(item_epg);Lampa.Settings.create('iptv_settings_panel', { title: 'Настройки IPTV', body: body, onBack: function() { Lampa.Settings.open('main'); } });}if (window.appready) startPlugin();else window.addEventListener('appready', startPlugin);})();