pc.extend(pc, function () {

    /**
     * @name pc.Application
     * @class Default application which performs general setup code and initiates the main game loop
     * @constructor Create a new Application
     * @param {DOMElement} canvas The canvas element
     * @param {Object} options
     * @param {pc.Controller} [options.controller] Generic input controller
     * @param {pc.Keyboard} [options.keyboard] Keyboard handler for input
     * @param {pc.Mouse} [options.mouse] Mouse handler for input
     * @param {Object} [options.libraries] List of URLs to javascript libraries which should be loaded before the application starts or any packs are loaded
     * @param {Boolean} [options.displayLoader] Display resource loader information during the loading progress. Debug only
     * @param {pc.common.DepotApi} [options.depot] API interface to the current depot
     * @param {String} [options.scriptPrefix] Prefix to apply to script urls before loading
     *
     * @example
     * // Create application
     * var app = new pc.Application(canvas, options);
     * // Start game loop
     * app.start()
     * @property {Number} timeScale Scales the global time delta.
     */
    var Application = function (canvas, options) {
        options = options || {};

        // Open the log
        pc.log.open();
        // Add event support
        pc.events.attach(this);

        this._time = 0;
        this.timeScale = 1;

        this._librariesLoaded = false;
        this._fillMode = pc.FILLMODE_KEEP_ASPECT;
        this._resolutionMode = pc.RESOLUTION_FIXED;

        // for compatibility
        this.context = this;

        this.graphicsDevice = new pc.GraphicsDevice(canvas);
        this.systems = new pc.ComponentSystemRegistry();
        this._audioManager = new pc.AudioManager();
        this.loader = new pc.ResourceLoader();

        this.scene = null; //new pc.Scene();
        this.root = new pc.fw.Entity(this);
        this.assets = new pc.AssetRegistry(this.loader);
        this.renderer = new pc.ForwardRenderer(this.graphicsDevice);

        this.keyboard = options.keyboard || null;
        this.mouse = options.mouse || null;
        this.touch = options.touch || null;
        this.gamepads = options.gamepads || null;

        this._inTools = false;

        this._scriptPrefix = options.scriptPrefix || '';
        this._scripts = [];

        this.loader.addHandler("animation", new pc.AnimationHandler());
        this.loader.addHandler("model", new pc.ModelHandler(this.graphicsDevice));
        this.loader.addHandler("material", new pc.MaterialHandler(this.assets));
        this.loader.addHandler("texture", new pc.TextureHandler(this.graphicsDevice));
        this.loader.addHandler("text", new pc.TextHandler());
        this.loader.addHandler("json", new pc.JsonHandler());
        this.loader.addHandler("audio", new pc.AudioHandler(this._audioManager));
        this.loader.addHandler("script", new pc.ScriptHandler(this));
        this.loader.addHandler("scene", new pc.SceneHandler(this));
        this.loader.addHandler("cubemap", new pc.CubemapHandler(this.graphicsDevice, this.assets, this.loader));


        var rigidbodysys = new pc.RigidBodyComponentSystem(this);
        var collisionsys = new pc.CollisionComponentSystem(this);
        var ballsocketjointsys = new pc.BallSocketJointComponentSystem(this);
        var animationsys = new pc.AnimationComponentSystem(this);
        var modelsys = new pc.ModelComponentSystem(this);
        var camerasys = new pc.CameraComponentSystem(this);
        var lightsys = new pc.LightComponentSystem(this);
        var scriptsys = new pc.ScriptComponentSystem(this, options.scriptPrefix);
        var picksys = new pc.PickComponentSystem(this);
        var audiosourcesys = new pc.AudioSourceComponentSystem(this, this._audioManager);
        var audiolistenersys = new pc.AudioListenerComponentSystem(this, this._audioManager);
        var particlesystemsys = new pc.ParticleSystemComponentSystem(this);

        // Depending on browser add the correct visibiltychange event and store the name of the hidden attribute
        // in this._hiddenAttr.
        if (document.hidden !== undefined) {
            this._hiddenAttr = 'hidden';
            document.addEventListener('visibilitychange', this.onVisibilityChange.bind(this), false);
        } else if (document.mozHidden !== undefined) {
            this._hiddenAttr = 'mozHidden';
            document.addEventListener('mozvisibilitychange', this.onVisibilityChange.bind(this), false);
        } else if (document.msHidden !== undefined) {
            this._hiddenAttr = 'msHidden';
            document.addEventListener('msvisibilitychange', this.onVisibilityChange.bind(this), false);
        } else if (document.webkitHidden !== undefined) {
            this._hiddenAttr = 'webkitHidden';
            document.addEventListener('webkitvisibilitychange', this.onVisibilityChange.bind(this), false);
        }

        // Store application instance
        Application._applications[this.graphicsDevice.canvas.id] = this;
        Application._currentApplication = this;
    };

    Application._currentApplication = null;
    Application._applications = {};
    Application.getApplication = function (id) {
        if (id) {
            return Application._applications[id];
        } else {
            return Application._currentApplication;
        }

    };

    Application.prototype = {
        /**
        * @name pc.Application#configure
        * @description Load a configuration file from
        */
        configure: function (url, callback) {
            var self = this;
            pc.net.http.get(url, function (response) {
                var props = response['application_properties'];
                var assets = response['assets'];
                var scripts = response['scripts'];

                self._parseApplicationProperties(props, function (err) {
                    self._parseScripts(scripts)
                    self._parseAssets(assets);
                    if (!err) {
                        callback(null);
                    } else {
                        callback(err);
                    }
                });
            }, {
                error: function (status, xhr, e) {
                    callback(status);
                }
            });
        },

        preload: function (callback) {
            var self = this;

            this.systems.script.preloading = true;

            // get list of assets to preload
            var assets = this.assets.list({
                preload: true
            });

            // Mini-object used to measure progress of loading sets
            var Progress = function (length) {
                this.length = length;
                this.count = 0;

                this.inc = function () {
                    this.count++;
                }

                this.done = function () {
                    return (this.count === this.length);
                }
            };

            var _assets = new Progress(assets.length);
            var _scripts = new Progress(this._scripts.length);

            var _done = false;

            // check if all loading is done
            var done = function () {
                if (!_done && _assets.done() && _scripts.done()) {
                    _done = true;
                    self.systems.script.preloading = false;
                    callback();
                }
            }

            // totals loading progress of assets and scripts
            var total = assets.length + this._scripts.length;
            var count = function () {
                return _assets.count + _scripts.count;
            }

            var i;
            if (_assets.length) {
                for(i = 0; i < _assets.length; i++) {
                    if (!assets[i].loaded) {
                        assets[i].once('load', function (asset) {
                            _assets.inc()
                            self.fire("preload:progress", count()/total);

                            if (_assets.done()) {
                                done();
                            }
                        });

                        assets[i].once('error', function (err, asset) {
                            _assets.inc()
                            self.fire("preload:progress", count()/total);

                            if (_assets.done()) {
                                done();
                            }
                        });

                        this.assets.load(assets[i]);
                    } else {
                        _assets.inc()
                        self.fire("preload:progress", count()/total);

                        if (_assets.done()) {
                            done();
                        }
                    }
                }
            } else {
                done();
            }

            if (_scripts.length) {
                for (i = 0; i < _scripts.length; i++) {
                    var url = pc.path.join(this._scriptPrefix, this._scripts[i]);
                    this.loader.load(url, "script", function (err, ScriptType) {
                        if (err) {
                            console.error(err);
                        } else {
                            console.log(ScriptType);
                        }

                        _scripts.inc();
                        if (_scripts.done()) {
                            done();
                        }
                    });
                }
            } else {
                done();
            }
        },

        loadScene: function (url, callback) {
            this.loader.load(url, "scene", function (err, scene) {
                this.loader.patch({
                    resource: scene,
                    type: "scene"
                }, this.assets);

                if (!err) {
                    // Initialise pack settings
                    if (this.systems.rigidbody && typeof Ammo !== 'undefined') {
                        this.systems.rigidbody.setGravity(scene._gravity.x, scene._gravity.y, scene._gravity.z);
                    }
                    callback(null, scene);
                }
            }.bind(this));
        },

        // set application properties from data file
        _parseApplicationProperties: function (props, callback) {
            this._width = props['width'];
            this._height = props['height'];
            this.setCanvasResolution(props['resolution_mode'], this._width, this._height);
            this.setCanvasFillMode(props['fill_mode'], this._width, this._height)

            var len = props['libraries'].length;
            var count = len
            if (len) {
                // load libraries
                for (var i = 0; i < len; ++i) {
                    var url = props['libraries'][i];
                    this.loader.load(url, "script", function (err, script) {
                        count--;
                        if (err) {
                            callback(err);
                        } else if (count === 0) {
                            this.systems.rigidbody.onLibraryLoaded();
                            callback(null);
                        }
                    }.bind(this));
                }
            } else {
                callback(null);
            }
        },

        // insert assets into registry
        _parseAssets: function (assets) {
            for (var id in assets) {
                var data = assets[id];
                var asset = new pc.Asset(data['name'], data['type'], data['file'], data['data']);
                asset.id = parseInt(id);
                asset.preload = data.preload ? data.preload : false;
                this.assets.add(asset);
            }
        },

        // copy list of script urls to preload
        _parseScripts: function (scripts) {
            if (scripts) {
                this._scripts = pc.extend([], scripts);
            }
        },

        /**
         * @function
         * @name pc.Application#start
         * @description Start the Application updating
         */
        start: function () {
            if (this.scene && this.scene.root) {
                this.root.addChild(this.scene.root);
            }

            console.log("INITIALIZE");

            pc.ComponentSystem.initialize(this.root);
            pc.ComponentSystem.postInitialize(this.root);

            this.tick();
        },

        /**
        * Load a pack and asset set from a table of contents config
        * @param {String} name The name of the Table of Contents block to load
        */
        loadFromToc: function (name, success, error, progress) {
            if (!this.content) {
                error('No content');
            }

            var toc = this.content.toc[name];

            success = success || function () {};
            error = error || function () {};
            progress = progress || function () {};

            var requests = [];

            var guid = toc.packs[0];

            var onLoaded = function (resources) {
                // load pack
                this.loader.request(new pc.resources.PackRequest(guid)).then(function (resources) {
                    var pack = resources[0];
                    this.root.addChild(pack.hierarchy);
                    pc.ComponentSystem.initialize(pack.hierarchy);
                    pc.ComponentSystem.postInitialize(pack.hierarchy);

                    // Initialise pack settings
                    if (this.systems.rigidbody && typeof Ammo !== 'undefined') {
                        var gravity = pack.settings.physics.gravity;
                        this.systems.rigidbody.setGravity(gravity[0], gravity[1], gravity[2]);
                    }

                    var ambientLight = pack.settings.render.global_ambient;
                    this.scene.ambientLight = new pc.Color(ambientLight[0], ambientLight[1], ambientLight[2]);

                    this.scene.fog = pack.settings.render.fog;
                    var fogColor = pack.settings.render.fog_color;
                    this.scene.fogColor = new pc.Color(fogColor[0], fogColor[1], fogColor[2]);
                    this.scene.fogStart = pack.settings.render.fog_start;
                    this.scene.fogEnd = pack.settings.render.fog_end;
                    this.scene.fogDensity = pack.settings.render.fog_density;
                    this.scene.gammaCorrection = pack.settings.render.gamma_correction;
                    this.scene.toneMapping = pack.settings.render.tonemapping;
                    this.scene.exposure = pack.settings.render.exposure;
                    this.scene.skyboxIntensity = pack.settings.render.skyboxIntensity===undefined? 1 : pack.settings.render.skyboxIntensity;
                    this.scene.skyboxMip = pack.settings.render.skyboxMip===undefined? 0 : pack.settings.render.skyboxMip;

                    if (pack.settings.render.skybox) {
                        var skybox = this.assets.getAssetById(pack.settings.render.skybox);
                        if (skybox) {
                            this._setSkybox(skybox.resources);

                            skybox.on('change', this._onSkyBoxChanged, this);
                            skybox.on('remove', this._onSkyBoxRemoved, this);
                        } else {
                            this.scene.skybox = null;
                        }
                    }

                    success(pack);
                    this.loader.off('progress', progress);
                }.bind(this), function (msg) {
                    error(msg);
                }).then(null, function (error) {
                    // Re-throw any exceptions from the script's initialize method to stop them being swallowed by the Promises lib
                    setTimeout(function () {
                        throw error;
                    }, 0);
                });
            }.bind(this);

            var load = function () {
                // Get a list of asset for the first Pack
                var assets = this.assets.list(guid);

                // start recording loading progress from here
                this.loader.on('progress', progress);

                if (assets.length) {
                    this.assets.load(assets).then(function (resources) {
                        onLoaded(resources);
                    });
                } else {
                    // No assets to load
                    setTimeout(function () {
                        onLoaded([]);
                    }, 0);
                }
            }.bind(this);

            if (!this._librariesLoaded) {
                this.on('librariesloaded', function () {
                    load();
                });
            } else {
                load();
            }
        },

        /**
         * @function
         * @name pc.Application#update
         * @description Application specific update method. Override this if you have a custom Application
         * @param {Number} dt The time delta since the last frame.
         */
        update: function (dt) {
            // Perform ComponentSystem update
            pc.ComponentSystem.fixedUpdate(1.0 / 60.0, this._inTools);
            pc.ComponentSystem.update(dt, this._inTools);
            pc.ComponentSystem.postUpdate(dt, this._inTools);

            // fire update event
            this.fire("update", dt);

            if (this.controller) {
                this.controller.update(dt);
            }
            if (this.mouse) {
                this.mouse.update(dt);
            }
            if (this.keyboard) {
                this.keyboard.update(dt);
            }
            if (this.gamepads) {
                this.gamepads.update(dt);
            }
        },

        /**
         * @function
         * @name pc.Application#render
         * @description Application specific render method. Override this if you have a custom Application
         */
        render: function () {
            var cameras = this.systems.camera.cameras;
            var camera = null;
            var renderer = this.renderer;

            this.root.syncHierarchy();

            // render the scene from each camera
            for (var i=0,len=cameras.length; i<len; i++) {
                camera = cameras[i];
                camera.frameBegin();
                renderer.render(this.scene, camera.camera);
                camera.frameEnd();
            }
        },

        /**
         * @function
         * @name pc.Application#tick
         * @description Application specific tick method that calls update and render and queues
         * the next tick. Override this if you have a custom Application.
         */
        tick: function () {
            Application._currentApplication = this;

            // Submit a request to queue up a new animation frame immediately
            window.requestAnimationFrame(this.tick.bind(this));

            var now = (window.performance && window.performance.now) ? performance.now() : Date.now();
            var dt = (now - (this._time || now)) / 1000.0;

            this._time = now;

            dt = pc.math.clamp(dt, 0, 0.1); // Maximum delta is 0.1s or 10 fps.
            dt *= this.timeScale;

            this.update(dt);
            this.render();
        },

        /**
        * @function
        * @name pc.Application#setCanvasFillMode
        * @description Change the way the canvas fills the window and resizes when the window changes
        * In KEEP_ASPECT mode, the canvas will grow to fill the window as best it can while maintaining the aspect ratio
        * In FILL_WINDOW mode, the canvas will simply fill the window, changing aspect ratio
        * In NONE mode, the canvas will always match the size provided
        * @param {pc.FillMode} mode The mode to use when setting the size of the canvas
        * @param {Number} [width] The width of the canvas, only used in NONE mode
        * @param {Number} [height] The height of the canvase, only used in NONE mode
        */
        setCanvasFillMode: function (mode, width, height) {
            this._fillMode = mode;
            this.resizeCanvas(width, height);
        },

        /**
        * @function
        * @name pc.Application#setCanvasResolution
        * @description Change the resolution of the canvas, and set the way it behaves when the window is resized
        * In AUTO mode, the resolution is change to match the size of the canvas when the canvas resizes
        * In FIXED mode, the resolution remains until another call to setCanvasResolution()
        * @param {pc.ResolutionMode} mode The mode to use when setting the resolution
        * @param {Number} [width] The horizontal resolution, optional in AUTO mode, if not provided canvas clientWidth is used
        * @param {Number} [height] The vertical resolution, optional in AUTO mode, if not provided canvas clientHeight is used
        */
        setCanvasResolution: function (mode, width, height) {
            this._resolutionMode = mode;

            // In AUTO mode the resolution is the same as the canvas size, unless specified
            if (mode === pc.RESOLUTION_AUTO && (width === undefined)) {
                width = this.graphicsDevice.canvas.clientWidth;
                height = this.graphicsDevice.canvas.clientHeight;
            }

            this.graphicsDevice.resizeCanvas(width, height);
        },

        /**
        * @function
        * @name pc.Application#isFullscreen
        * @description Returns true if the application is currently running fullscreen
        * @returns {Boolean} True if the application is running fullscreen
        */
        isFullscreen: function () {
            return !!document.fullscreenElement;
        },

        /**
        * @function
        * @name pc.Application#enableFullscreen
        * @description Request that the browser enters fullscreen mode. This is not available on all browsers.
        * Note: Switching to fullscreen can only be initiated by a user action, e.g. in the event hander for a mouse or keyboard input
        * @param {DOMElement} [element] The element to display in fullscreen, if element is not provided the application canvas is used
        * @param {Function} [success] Function called if the request for fullscreen was successful
        * @param {Function} [error] Function called if the request for fullscreen was unsuccessful
        * @example
        * var canvas = document.getElementById('application-canvas');
        * var application = pc.Application.getApplication(canvas.id);
        * var button = document.getElementById('my-button');
        * button.addEventListener('click', function () {
        *     application.enableFullscreen(canvas, function () {
        *         console.log('fullscreen');
        *     }, function () {
        *         console.log('not fullscreen');
        *     });
        * }, false);
        */
        enableFullscreen: function (element, success, error) {
            element = element || this.graphicsDevice.canvas;

            // success callback
            var s = function () {
                success();
                document.removeEventListener('fullscreenchange', s);
            };

            // error callback
            var e = function () {
                error();
                document.removeEventListener('fullscreenerror', e);
            };

            if (success) {
                document.addEventListener('fullscreenchange', s, false);
            }

            if (error) {
                document.addEventListener('fullscreenerror', e, false);
            }
            element.requestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
        },

        /**
        * @function
        * @name pc.Application#disableFullscreen
        * @description If application is currently displaying an element as fullscreen, then stop and return to normal.
        * @param {Function} [success] Function called when transition to normal mode is finished
        */
        disableFullscreen: function (success) {
            // success callback
            var s = function () {
                success();
                document.removeEventListener('fullscreenchange', s);
            };

            if (success) {
                document.addEventListener('fullscreenchange', s, false);
            }

            document.exitFullscreen();
        },

        /**
        * @function
        * @name pc.Application#isHidden
        * @description Returns true if the window or tab in which the application is running in is not visible to the user.
        */
        isHidden: function () {
            return document[this._hiddenAttr];
        },

        /**
        * @private
        * @function
        * @name pc.Application#onVisibilityChange
        * @description Called when the visibility state of the current tab/window changes
        */
        onVisibilityChange: function (e) {
            if (this.isHidden()) {
                this._audioManager.suspend();
            } else {
                this._audioManager.resume();
            }
        },

        /**
        * @function
        * @name pc.Application#resizeCanvas
        * @description Resize the canvas in line with the current FillMode
        * In KEEP_ASPECT mode, the canvas will grow to fill the window as best it can while maintaining the aspect ratio
        * In FILL_WINDOW mode, the canvas will simply fill the window, changing aspect ratio
        * In NONE mode, the canvas will always match the size provided
        * @param {Number} [width] The width of the canvas, only used in NONE mode
        * @param {Number} [height] The height of the canvas, only used in NONE mode
        * @returns {Object} A object containing the values calculated to use as width and height
        */
        resizeCanvas: function (width, height) {
            var windowWidth = window.innerWidth;
            var windowHeight = window.innerHeight;

            if (navigator.isCocoonJS) {
                width = windowWidth;
                height = windowHeight;

                var ratio = window.devicePixelRatio;
                this.graphicsDevice.resizeCanvas(width * ratio, height * ratio);
            } else {
                if (this._fillMode === pc.FILLMODE_KEEP_ASPECT) {
                    var r = this.graphicsDevice.canvas.width/this.graphicsDevice.canvas.height;
                    var winR = windowWidth / windowHeight;

                    if (r > winR) {
                        width = windowWidth;
                        height = width / r ;
                    } else {
                        height = windowHeight;
                        width = height * r;
                    }
                } else if (this._fillMode === pc.FILLMODE_FILL_WINDOW) {
                    width = windowWidth;
                    height = windowHeight;
                } else {
                    // FILLMODE_NONE use width and height that are provided
                }

                this.graphicsDevice.canvas.style.width = width + 'px';
                this.graphicsDevice.canvas.style.height = height + 'px';

                // In AUTO mode the resolution is changed to match the canvas size
                if (this._resolutionMode === pc.RESOLUTION_AUTO) {
                    this.setCanvasResolution(pc.RESOLUTION_AUTO);
                }
            }

            // return the final values calculated for width and height
            return {
                width: width,
                height: height
            };
        },

        /**
        * @private
        * @name pc.Application#onLibrariesLoaded
        * @description Event handler called when all code libraries have been loaded
        * Code libraries are passed into the constructor of the Application and the application won't start running or load packs until all libraries have
        * been loaded
        */
        onLibrariesLoaded: function () {
            this.systems.rigidbody.onLibraryLoaded();
            this.systems.collision.onLibraryLoaded();
        },

        updateSceneSettings: function (settings) {
            var self = this;

            var ambient = settings.render.global_ambient;
            self.scene.ambientLight.set(ambient[0], ambient[1], ambient[2]);

            if (self.systems.rigidbody && typeof Ammo !== 'undefined') {
                var gravity = settings.physics.gravity;
                self.systems.rigidbody.setGravity(gravity[0], gravity[1], gravity[2]);
            }

            self.scene.fog = settings.render.fog;
            self.scene.fogStart = settings.render.fog_start;
            self.scene.fogEnd = settings.render.fog_end;

            var fog = settings.render.fog_color;
            self.scene.fogColor = new pc.Color(fog[0], fog[1], fog[2]);
            self.scene.fogDensity = settings.render.fog_density;

            self.scene.gammaCorrection = settings.render.gamma_correction;
            self.scene.toneMapping = settings.render.tonemapping;
            self.scene.exposure = settings.render.exposure;
            self.scene.skyboxIntensity = settings.render.skyboxIntensity===undefined? 1 : settings.render.skyboxIntensity;
            self.scene.skyboxMip = settings.render.skyboxMip===undefined? 0 : settings.render.skyboxMip;

            if (settings.render.skybox) {
                var asset = self.assets.get(settings.render.skybox);
                if (asset) {
                    asset.ready(function (asset) {
                        self.scene.attachSkyboxAsset(asset);
                    });
                    self.assets.load(asset);
                } else {
                    self.assets.once("add:" + settings.render.skybox, function (asset) {
                        asset.ready(function (asset) {
                            self.scene.attachSkyboxAsset(asset);
                        });
                        self.assets.load(asset);
                    });
                }
            } else {
                self.scene.setSkybox(null);
            }
        }
    };

    return {
        /**
         * @enum pc.FILLMODE
         * @name pc.FILLMODE_NONE
         * @description When resizing the window the size of the canvas will not change.
         */
        FILLMODE_NONE: 'NONE',
        /**
         * @enum pc.FILLMODE
         * @name pc.FILLMODE_FILL_WINDOW
         * @description When resizing the window the size of the canvas will change to fill the window exactly.
         */
        FILLMODE_FILL_WINDOW: 'FILL_WINDOW',
        /**
         * @enum pc.FILLMODE
         * @name pc.FILLMODE_KEEP_ASPECT
         * @description When resizing the window the size of the canvas will change to fill the window as best it can, while maintaining the same aspect ratio.
         */
        FILLMODE_KEEP_ASPECT: 'KEEP_ASPECT',
        /**
        * @enum pc.RESOLUTION
        * @name pc.RESOLUTION_AUTO
        * @description When the canvas is resized the resolution of the canvas will change to match the size of the canvas.
        */
        RESOLUTION_AUTO: 'AUTO',
        /**
        * @enum pc.RESOLUTION
        * @name pc.RESOLUTION_FIXED
        * @description When the canvas is resized the resolution of the canvas will remain at the same value and the output will just be scaled to fit the canvas.
        */
        RESOLUTION_FIXED: 'FIXED',

        Application: Application
    };
} ());




