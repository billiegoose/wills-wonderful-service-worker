/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const Comlink = (function () {
    const uid = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    let pingPongMessageCounter = 0;
    const TRANSFERABLE_TYPES = [ArrayBuffer, MessagePort];
    const proxyValueSymbol = Symbol('proxyValue');
    // Symbols are not transferable. For the case where a parameter needs to be
    // proxy’d, we need to set some sort of transferable, secret marker. This is it.
    const transferMarker = '__omg_so_secret';
    /* export */ function proxy(endpoint) {
        if (isWindow(endpoint))
            endpoint = windowEndpoint(endpoint);
        if (!isEndpoint(endpoint))
            throw Error('endpoint does not have all of addEventListener, removeEventListener and postMessage defined');
        activateEndpoint(endpoint);
        return batchingProxy(async (irequest) => {
            let args = [];
            if (irequest.type === 'APPLY' || irequest.type === 'CONSTRUCT') {
                args = irequest.argumentsList =
                    irequest.argumentsList.map(arg => {
                        if (!isProxyValue(arg))
                            return arg;
                        const { port1, port2 } = new MessageChannel();
                        expose(arg, port1);
                        return {
                            [transferMarker]: 'PROXY',
                            endpoint: port2,
                        };
                    });
            }
            const response = await pingPongMessage(endpoint, irequest, transferableProperties(args));
            const result = response.data;
            if (result.type === 'ERROR')
                throw Error(result.error);
            if (result.type === 'PROXY')
                return proxy(result.endpoint);
            return result.obj;
        });
    }
    /* export */ function proxyValue(obj) {
        obj[proxyValueSymbol] = true;
        return obj;
    }
    /* export */ function expose(rootObj, endpoint) {
        if (isWindow(endpoint))
            endpoint = windowEndpoint(endpoint);
        if (!isEndpoint(endpoint))
            throw Error('endpoint does not have all of addEventListener, removeEventListener and postMessage defined');
        activateEndpoint(endpoint);
        attachMessageHandler(endpoint, async function (event) {
            if (!event.data.id)
                return;
            const irequest = event.data;
            let that = await irequest.callPath.slice(0, -1).reduce((obj, propName) => obj[propName], rootObj);
            let obj = await irequest.callPath.reduce((obj, propName) => obj[propName], rootObj);
            const isAsyncGenerator = obj.constructor.name === 'AsyncGeneratorFunction';
            let iresult = obj;
            let ierror;
            // If there is an arguments list, proxy-fy parameters as necessary
            if ('argumentsList' in irequest) {
                irequest.argumentsList =
                    irequest.argumentsList.map(arg => {
                        if (arg[transferMarker] === 'PROXY')
                            return proxy(arg.endpoint);
                        else
                            return arg;
                    });
            }
            if (irequest.type === 'APPLY') {
                try {
                    iresult = await obj.apply(that, irequest.argumentsList);
                }
                catch (e) {
                    ierror = e;
                }
            }
            if (isAsyncGenerator)
                iresult = proxyValue(iresult);
            if (irequest.type === 'CONSTRUCT') {
                try {
                    iresult = new obj(...(irequest.argumentsList || [])); // eslint-disable-line new-cap
                    iresult = proxyValue(iresult);
                }
                catch (e) {
                    ierror = e;
                }
            }
            if (irequest.type === 'SET') {
                obj[irequest.property] = irequest.value;
                // FIXME: ES6 Proxy Handler `set` methods are supposed to return a
                // boolean. To show good will, we return true asynchronously ¯\_(ツ)_/¯
                iresult = true;
            }
            iresult = makeInvocationResult(iresult, ierror);
            iresult.id = irequest.id;
            return endpoint.postMessage(iresult, transferableProperties([iresult]));
        });
    }
    function windowEndpoint(w) {
        if (self.constructor.name !== 'Window')
            throw Error('self is not a window');
        return {
            addEventListener: self.addEventListener.bind(self),
            removeEventListener: self.removeEventListener.bind(self),
            postMessage: (msg, transfer) => w.postMessage(msg, '*', transfer),
        };
    }
    function isEndpoint(endpoint) {
        return 'addEventListener' in endpoint && 'removeEventListener' in endpoint && 'postMessage' in endpoint;
    }
    function activateEndpoint(endpoint) {
        if (isMessagePort(endpoint))
            endpoint.start();
    }
    function attachMessageHandler(endpoint, f) {
        // Checking all possible types of `endpoint` manually satisfies TypeScript’s
        // type checker. Not sure why the inference is failing here. Since it’s
        // unnecessary code I’m going to resort to `any` for now.
        // if(isWorker(endpoint))
        //   endpoint.addEventListener('message', f);
        // if(isMessagePort(endpoint))
        //   endpoint.addEventListener('message', f);
        // if(isOtherWindow(endpoint))
        //   endpoint.addEventListener('message', f);
        endpoint.addEventListener('message', f);
    }
    function detachMessageHandler(endpoint, f) {
        // Same as above.
        endpoint.removeEventListener('message', f);
    }
    function isMessagePort(endpoint) {
        return endpoint.constructor.name === 'MessagePort';
    }
    function isWindow(endpoint) {
        // TODO: This doesn’t work on cross-origin iframes.
        // return endpoint.constructor.name === 'Window';
        return ['window', 'length', 'location', 'parent', 'opener'].every(prop => prop in endpoint);
    }
    /**
     * `pingPongMessage` sends a `postMessage` and waits for a reply. Replies are
     * identified by a unique id that is attached to the payload.
     */
    function pingPongMessage(endpoint, msg, transferables) {
        const id = `${uid}-${pingPongMessageCounter++}`;
        return new Promise(resolve => {
            attachMessageHandler(endpoint, function handler(event) {
                if (event.data.id !== id)
                    return;
                detachMessageHandler(endpoint, handler);
                resolve(event);
            });
            // Copy msg and add `id` property
            msg = Object.assign({}, msg, { id });
            endpoint.postMessage(msg, transferables);
        });
    }
    function asyncIteratorSupport() {
        return 'asyncIterator' in Symbol;
    }
    /**
     * `batchingProxy` creates a ES6 Proxy that batches `get`s until either
     * `construct` or `apply` is called. At that point the callback is invoked with
     * the accumulated call path.
     */
    function batchingProxy(cb) {
        let callPath = [];
        return new Proxy(function () { }, {
            construct(_target, argumentsList, proxy) {
                const r = cb({
                    type: 'CONSTRUCT',
                    callPath,
                    argumentsList,
                });
                callPath = [];
                return r;
            },
            apply(_target, _thisArg, argumentsList) {
                // We use `bind` as an indicator to have a remote function bound locally.
                // The actual target for `bind()` is currently ignored.
                if (callPath[callPath.length - 1] === 'bind') {
                    const localCallPath = callPath.slice();
                    callPath = [];
                    return (...args) => cb({
                        type: 'APPLY',
                        callPath: localCallPath.slice(0, -1),
                        argumentsList: args,
                    });
                }
                const r = cb({
                    type: 'APPLY',
                    callPath,
                    argumentsList,
                });
                callPath = [];
                return r;
            },
            get(_target, property, proxy) {
                if (property === 'then' && callPath.length === 0) {
                    return { then: () => proxy };
                }
                else if (asyncIteratorSupport() && property === Symbol.asyncIterator) {
                    // For now, only async generators use `Symbol.asyncIterator` and they
                    // return themselves, so we emulate that behavior here.
                    return () => proxy;
                }
                else if (property === 'then') {
                    const r = cb({
                        type: 'GET',
                        callPath,
                    });
                    callPath = [];
                    return Promise.resolve(r).then.bind(r);
                }
                else {
                    callPath.push(property);
                    return proxy;
                }
            },
            set(_target, property, value, _proxy) {
                return cb({
                    type: 'SET',
                    callPath,
                    property,
                    value,
                });
            },
        });
    }
    function isTransferable(thing) {
        return TRANSFERABLE_TYPES.some(type => thing instanceof type);
    }
    function* iterateAllProperties(obj) {
        if (!obj)
            return;
        if (typeof obj === 'string')
            return;
        yield obj;
        let vals = Object.values(obj);
        if (Array.isArray(obj))
            vals = obj;
        for (const val of vals)
            yield* iterateAllProperties(val);
    }
    function transferableProperties(obj) {
        const r = [];
        for (const prop of iterateAllProperties(obj)) {
            if (isTransferable(prop))
                r.push(prop);
        }
        return r;
    }
    function isProxyValue(obj) {
        return obj && obj[proxyValueSymbol];
    }
    function makeInvocationResult(obj, err = null) {
        if (err) {
            return {
                type: 'ERROR',
                error: ('stack' in err) ? err.stack : err.toString(),
            };
        }
        // TODO We actually need to perform a structured clone tree
        // walk of the data as we want to allow:
        // return {foo: proxyValue(foo)};
        // We also don't want to directly mutate the data as:
        // class A {
        //   constructor() { this.b = {b: proxyValue(new B())} }
        //   method1() { return this.b; }
        //   method2() { this.b.foo; /* should work */ }
        // }
        if (isProxyValue(obj)) {
            const { port1, port2 } = new MessageChannel();
            expose(obj, port1);
            return {
                type: 'PROXY',
                endpoint: port2,
            };
        }
        return {
            type: 'OBJECT',
            obj,
        };
    }
    return { proxy, proxyValue, expose };
})();

function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var pify = createCommonjsModule(function (module) {
const processFn = (fn, opts) => function () {
	const P = opts.promiseModule;
	const args = new Array(arguments.length);

	for (let i = 0; i < arguments.length; i++) {
		args[i] = arguments[i];
	}

	return new P((resolve, reject) => {
		if (opts.errorFirst) {
			args.push(function (err, result) {
				if (opts.multiArgs) {
					const results = new Array(arguments.length - 1);

					for (let i = 1; i < arguments.length; i++) {
						results[i - 1] = arguments[i];
					}

					if (err) {
						results.unshift(err);
						reject(results);
					} else {
						resolve(results);
					}
				} else if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			});
		} else {
			args.push(function (result) {
				if (opts.multiArgs) {
					const results = new Array(arguments.length - 1);

					for (let i = 0; i < arguments.length; i++) {
						results[i] = arguments[i];
					}

					resolve(results);
				} else {
					resolve(result);
				}
			});
		}

		fn.apply(this, args);
	});
};

module.exports = (obj, opts) => {
	opts = Object.assign({
		exclude: [/.+(Sync|Stream)$/],
		errorFirst: true,
		promiseModule: Promise
	}, opts);

	const filter = key => {
		const match = pattern => typeof pattern === 'string' ? key === pattern : pattern.test(key);
		return opts.include ? opts.include.some(match) : !opts.exclude.some(match);
	};

	let ret;
	if (typeof obj === 'function') {
		ret = function () {
			if (opts.excludeMain) {
				return obj.apply(this, arguments);
			}

			return processFn(obj, opts).apply(this, arguments);
		};
	} else {
		ret = Object.create(Object.getPrototypeOf(obj));
	}

	for (const key in obj) { // eslint-disable-line guard-for-in
		const x = obj[key];
		ret[key] = typeof x === 'function' && filter(key) ? processFn(x, opts) : x;
	}

	return ret;
};
});

/**
 * I had to bundle this one myself.
 */
(function (f) {
    if (typeof exports === "object" && typeof module !== "undefined") {
        module.exports = f();
    } else if (typeof define === "function" && define.amd) {
        define([], f);
    } else {
        var g;if (typeof window !== "undefined") {
            g = window;
        } else if (typeof global !== "undefined") {
            g = global;
        } else if (typeof self !== "undefined") {
            g = self;
        } else {
            g = this;
        }g.mime = f();
    }
})(function () {
    return function e(t, n, r) {
        function s(o, u) {
            if (!n[o]) {
                if (!t[o]) {
                    var a = typeof require == "function" && require;if (!u && a) return a(o, !0);if (i) return i(o, !0);var f = new Error("Cannot find module '" + o + "'");throw f.code = "MODULE_NOT_FOUND", f;
                }var l = n[o] = { exports: {} };t[o][0].call(l.exports, function (e) {
                    var n = t[o][1][e];return s(n ? n : e);
                }, l, l.exports, e, t, n, r);
            }return n[o].exports;
        }var i = typeof require == "function" && require;for (var o = 0; o < r.length; o++) s(r[o]);return s;
    }({ 1: [function (require, module, exports) {
            module.exports = { "application/andrew-inset": ["ez"], "application/applixware": ["aw"], "application/atom+xml": ["atom"], "application/atomcat+xml": ["atomcat"], "application/atomsvc+xml": ["atomsvc"], "application/bdoc": ["bdoc"], "application/ccxml+xml": ["ccxml"], "application/cdmi-capability": ["cdmia"], "application/cdmi-container": ["cdmic"], "application/cdmi-domain": ["cdmid"], "application/cdmi-object": ["cdmio"], "application/cdmi-queue": ["cdmiq"], "application/cu-seeme": ["cu"], "application/dash+xml": ["mpd"], "application/davmount+xml": ["davmount"], "application/docbook+xml": ["dbk"], "application/dssc+der": ["dssc"], "application/dssc+xml": ["xdssc"], "application/ecmascript": ["ecma"], "application/emma+xml": ["emma"], "application/epub+zip": ["epub"], "application/exi": ["exi"], "application/font-tdpfr": ["pfr"], "application/font-woff": ["woff"], "application/font-woff2": ["woff2"], "application/gml+xml": ["gml"], "application/gpx+xml": ["gpx"], "application/gxf": ["gxf"], "application/hyperstudio": ["stk"], "application/inkml+xml": ["ink", "inkml"], "application/ipfix": ["ipfix"], "application/java-archive": ["jar", "war", "ear"], "application/java-serialized-object": ["ser"], "application/java-vm": ["class"], "application/javascript": ["js"], "application/json": ["json", "map"], "application/json5": ["json5"], "application/jsonml+json": ["jsonml"], "application/ld+json": ["jsonld"], "application/lost+xml": ["lostxml"], "application/mac-binhex40": ["hqx"], "application/mac-compactpro": ["cpt"], "application/mads+xml": ["mads"], "application/manifest+json": ["webmanifest"], "application/marc": ["mrc"], "application/marcxml+xml": ["mrcx"], "application/mathematica": ["ma", "nb", "mb"], "application/mathml+xml": ["mathml"], "application/mbox": ["mbox"], "application/mediaservercontrol+xml": ["mscml"], "application/metalink+xml": ["metalink"], "application/metalink4+xml": ["meta4"], "application/mets+xml": ["mets"], "application/mods+xml": ["mods"], "application/mp21": ["m21", "mp21"], "application/mp4": ["mp4s", "m4p"], "application/msword": ["doc", "dot"], "application/mxf": ["mxf"], "application/octet-stream": ["bin", "dms", "lrf", "mar", "so", "dist", "distz", "pkg", "bpk", "dump", "elc", "deploy", "exe", "dll", "deb", "dmg", "iso", "img", "msi", "msp", "msm", "buffer"], "application/oda": ["oda"], "application/oebps-package+xml": ["opf"], "application/ogg": ["ogx"], "application/omdoc+xml": ["omdoc"], "application/onenote": ["onetoc", "onetoc2", "onetmp", "onepkg"], "application/oxps": ["oxps"], "application/patch-ops-error+xml": ["xer"], "application/pdf": ["pdf"], "application/pgp-encrypted": ["pgp"], "application/pgp-signature": ["asc", "sig"], "application/pics-rules": ["prf"], "application/pkcs10": ["p10"], "application/pkcs7-mime": ["p7m", "p7c"], "application/pkcs7-signature": ["p7s"], "application/pkcs8": ["p8"], "application/pkix-attr-cert": ["ac"], "application/pkix-cert": ["cer"], "application/pkix-crl": ["crl"], "application/pkix-pkipath": ["pkipath"], "application/pkixcmp": ["pki"], "application/pls+xml": ["pls"], "application/postscript": ["ai", "eps", "ps"], "application/prs.cww": ["cww"], "application/pskc+xml": ["pskcxml"], "application/rdf+xml": ["rdf"], "application/reginfo+xml": ["rif"], "application/relax-ng-compact-syntax": ["rnc"], "application/resource-lists+xml": ["rl"], "application/resource-lists-diff+xml": ["rld"], "application/rls-services+xml": ["rs"], "application/rpki-ghostbusters": ["gbr"], "application/rpki-manifest": ["mft"], "application/rpki-roa": ["roa"], "application/rsd+xml": ["rsd"], "application/rss+xml": ["rss"], "application/rtf": ["rtf"], "application/sbml+xml": ["sbml"], "application/scvp-cv-request": ["scq"], "application/scvp-cv-response": ["scs"], "application/scvp-vp-request": ["spq"], "application/scvp-vp-response": ["spp"], "application/sdp": ["sdp"], "application/set-payment-initiation": ["setpay"], "application/set-registration-initiation": ["setreg"], "application/shf+xml": ["shf"], "application/smil+xml": ["smi", "smil"], "application/sparql-query": ["rq"], "application/sparql-results+xml": ["srx"], "application/srgs": ["gram"], "application/srgs+xml": ["grxml"], "application/sru+xml": ["sru"], "application/ssdl+xml": ["ssdl"], "application/ssml+xml": ["ssml"], "application/tei+xml": ["tei", "teicorpus"], "application/thraud+xml": ["tfi"], "application/timestamped-data": ["tsd"], "application/vnd.3gpp.pic-bw-large": ["plb"], "application/vnd.3gpp.pic-bw-small": ["psb"], "application/vnd.3gpp.pic-bw-var": ["pvb"], "application/vnd.3gpp2.tcap": ["tcap"], "application/vnd.3m.post-it-notes": ["pwn"], "application/vnd.accpac.simply.aso": ["aso"], "application/vnd.accpac.simply.imp": ["imp"], "application/vnd.acucobol": ["acu"], "application/vnd.acucorp": ["atc", "acutc"], "application/vnd.adobe.air-application-installer-package+zip": ["air"], "application/vnd.adobe.formscentral.fcdt": ["fcdt"], "application/vnd.adobe.fxp": ["fxp", "fxpl"], "application/vnd.adobe.xdp+xml": ["xdp"], "application/vnd.adobe.xfdf": ["xfdf"], "application/vnd.ahead.space": ["ahead"], "application/vnd.airzip.filesecure.azf": ["azf"], "application/vnd.airzip.filesecure.azs": ["azs"], "application/vnd.amazon.ebook": ["azw"], "application/vnd.americandynamics.acc": ["acc"], "application/vnd.amiga.ami": ["ami"], "application/vnd.android.package-archive": ["apk"], "application/vnd.anser-web-certificate-issue-initiation": ["cii"], "application/vnd.anser-web-funds-transfer-initiation": ["fti"], "application/vnd.antix.game-component": ["atx"], "application/vnd.apple.installer+xml": ["mpkg"], "application/vnd.apple.mpegurl": ["m3u8"], "application/vnd.apple.pkpass": ["pkpass"], "application/vnd.aristanetworks.swi": ["swi"], "application/vnd.astraea-software.iota": ["iota"], "application/vnd.audiograph": ["aep"], "application/vnd.blueice.multipass": ["mpm"], "application/vnd.bmi": ["bmi"], "application/vnd.businessobjects": ["rep"], "application/vnd.chemdraw+xml": ["cdxml"], "application/vnd.chipnuts.karaoke-mmd": ["mmd"], "application/vnd.cinderella": ["cdy"], "application/vnd.claymore": ["cla"], "application/vnd.cloanto.rp9": ["rp9"], "application/vnd.clonk.c4group": ["c4g", "c4d", "c4f", "c4p", "c4u"], "application/vnd.cluetrust.cartomobile-config": ["c11amc"], "application/vnd.cluetrust.cartomobile-config-pkg": ["c11amz"], "application/vnd.commonspace": ["csp"], "application/vnd.contact.cmsg": ["cdbcmsg"], "application/vnd.cosmocaller": ["cmc"], "application/vnd.crick.clicker": ["clkx"], "application/vnd.crick.clicker.keyboard": ["clkk"], "application/vnd.crick.clicker.palette": ["clkp"], "application/vnd.crick.clicker.template": ["clkt"], "application/vnd.crick.clicker.wordbank": ["clkw"], "application/vnd.criticaltools.wbs+xml": ["wbs"], "application/vnd.ctc-posml": ["pml"], "application/vnd.cups-ppd": ["ppd"], "application/vnd.curl.car": ["car"], "application/vnd.curl.pcurl": ["pcurl"], "application/vnd.dart": ["dart"], "application/vnd.data-vision.rdz": ["rdz"], "application/vnd.dece.data": ["uvf", "uvvf", "uvd", "uvvd"], "application/vnd.dece.ttml+xml": ["uvt", "uvvt"], "application/vnd.dece.unspecified": ["uvx", "uvvx"], "application/vnd.dece.zip": ["uvz", "uvvz"], "application/vnd.denovo.fcselayout-link": ["fe_launch"], "application/vnd.dna": ["dna"], "application/vnd.dolby.mlp": ["mlp"], "application/vnd.dpgraph": ["dpg"], "application/vnd.dreamfactory": ["dfac"], "application/vnd.ds-keypoint": ["kpxx"], "application/vnd.dvb.ait": ["ait"], "application/vnd.dvb.service": ["svc"], "application/vnd.dynageo": ["geo"], "application/vnd.ecowin.chart": ["mag"], "application/vnd.enliven": ["nml"], "application/vnd.epson.esf": ["esf"], "application/vnd.epson.msf": ["msf"], "application/vnd.epson.quickanime": ["qam"], "application/vnd.epson.salt": ["slt"], "application/vnd.epson.ssf": ["ssf"], "application/vnd.eszigno3+xml": ["es3", "et3"], "application/vnd.ezpix-album": ["ez2"], "application/vnd.ezpix-package": ["ez3"], "application/vnd.fdf": ["fdf"], "application/vnd.fdsn.mseed": ["mseed"], "application/vnd.fdsn.seed": ["seed", "dataless"], "application/vnd.flographit": ["gph"], "application/vnd.fluxtime.clip": ["ftc"], "application/vnd.framemaker": ["fm", "frame", "maker", "book"], "application/vnd.frogans.fnc": ["fnc"], "application/vnd.frogans.ltf": ["ltf"], "application/vnd.fsc.weblaunch": ["fsc"], "application/vnd.fujitsu.oasys": ["oas"], "application/vnd.fujitsu.oasys2": ["oa2"], "application/vnd.fujitsu.oasys3": ["oa3"], "application/vnd.fujitsu.oasysgp": ["fg5"], "application/vnd.fujitsu.oasysprs": ["bh2"], "application/vnd.fujixerox.ddd": ["ddd"], "application/vnd.fujixerox.docuworks": ["xdw"], "application/vnd.fujixerox.docuworks.binder": ["xbd"], "application/vnd.fuzzysheet": ["fzs"], "application/vnd.genomatix.tuxedo": ["txd"], "application/vnd.geogebra.file": ["ggb"], "application/vnd.geogebra.tool": ["ggt"], "application/vnd.geometry-explorer": ["gex", "gre"], "application/vnd.geonext": ["gxt"], "application/vnd.geoplan": ["g2w"], "application/vnd.geospace": ["g3w"], "application/vnd.gmx": ["gmx"], "application/vnd.google-apps.document": ["gdoc"], "application/vnd.google-apps.presentation": ["gslides"], "application/vnd.google-apps.spreadsheet": ["gsheet"], "application/vnd.google-earth.kml+xml": ["kml"], "application/vnd.google-earth.kmz": ["kmz"], "application/vnd.grafeq": ["gqf", "gqs"], "application/vnd.groove-account": ["gac"], "application/vnd.groove-help": ["ghf"], "application/vnd.groove-identity-message": ["gim"], "application/vnd.groove-injector": ["grv"], "application/vnd.groove-tool-message": ["gtm"], "application/vnd.groove-tool-template": ["tpl"], "application/vnd.groove-vcard": ["vcg"], "application/vnd.hal+xml": ["hal"], "application/vnd.handheld-entertainment+xml": ["zmm"], "application/vnd.hbci": ["hbci"], "application/vnd.hhe.lesson-player": ["les"], "application/vnd.hp-hpgl": ["hpgl"], "application/vnd.hp-hpid": ["hpid"], "application/vnd.hp-hps": ["hps"], "application/vnd.hp-jlyt": ["jlt"], "application/vnd.hp-pcl": ["pcl"], "application/vnd.hp-pclxl": ["pclxl"], "application/vnd.hydrostatix.sof-data": ["sfd-hdstx"], "application/vnd.ibm.minipay": ["mpy"], "application/vnd.ibm.modcap": ["afp", "listafp", "list3820"], "application/vnd.ibm.rights-management": ["irm"], "application/vnd.ibm.secure-container": ["sc"], "application/vnd.iccprofile": ["icc", "icm"], "application/vnd.igloader": ["igl"], "application/vnd.immervision-ivp": ["ivp"], "application/vnd.immervision-ivu": ["ivu"], "application/vnd.insors.igm": ["igm"], "application/vnd.intercon.formnet": ["xpw", "xpx"], "application/vnd.intergeo": ["i2g"], "application/vnd.intu.qbo": ["qbo"], "application/vnd.intu.qfx": ["qfx"], "application/vnd.ipunplugged.rcprofile": ["rcprofile"], "application/vnd.irepository.package+xml": ["irp"], "application/vnd.is-xpr": ["xpr"], "application/vnd.isac.fcs": ["fcs"], "application/vnd.jam": ["jam"], "application/vnd.jcp.javame.midlet-rms": ["rms"], "application/vnd.jisp": ["jisp"], "application/vnd.joost.joda-archive": ["joda"], "application/vnd.kahootz": ["ktz", "ktr"], "application/vnd.kde.karbon": ["karbon"], "application/vnd.kde.kchart": ["chrt"], "application/vnd.kde.kformula": ["kfo"], "application/vnd.kde.kivio": ["flw"], "application/vnd.kde.kontour": ["kon"], "application/vnd.kde.kpresenter": ["kpr", "kpt"], "application/vnd.kde.kspread": ["ksp"], "application/vnd.kde.kword": ["kwd", "kwt"], "application/vnd.kenameaapp": ["htke"], "application/vnd.kidspiration": ["kia"], "application/vnd.kinar": ["kne", "knp"], "application/vnd.koan": ["skp", "skd", "skt", "skm"], "application/vnd.kodak-descriptor": ["sse"], "application/vnd.las.las+xml": ["lasxml"], "application/vnd.llamagraphics.life-balance.desktop": ["lbd"], "application/vnd.llamagraphics.life-balance.exchange+xml": ["lbe"], "application/vnd.lotus-1-2-3": ["123"], "application/vnd.lotus-approach": ["apr"], "application/vnd.lotus-freelance": ["pre"], "application/vnd.lotus-notes": ["nsf"], "application/vnd.lotus-organizer": ["org"], "application/vnd.lotus-screencam": ["scm"], "application/vnd.lotus-wordpro": ["lwp"], "application/vnd.macports.portpkg": ["portpkg"], "application/vnd.mcd": ["mcd"], "application/vnd.medcalcdata": ["mc1"], "application/vnd.mediastation.cdkey": ["cdkey"], "application/vnd.mfer": ["mwf"], "application/vnd.mfmp": ["mfm"], "application/vnd.micrografx.flo": ["flo"], "application/vnd.micrografx.igx": ["igx"], "application/vnd.mif": ["mif"], "application/vnd.mobius.daf": ["daf"], "application/vnd.mobius.dis": ["dis"], "application/vnd.mobius.mbk": ["mbk"], "application/vnd.mobius.mqy": ["mqy"], "application/vnd.mobius.msl": ["msl"], "application/vnd.mobius.plc": ["plc"], "application/vnd.mobius.txf": ["txf"], "application/vnd.mophun.application": ["mpn"], "application/vnd.mophun.certificate": ["mpc"], "application/vnd.mozilla.xul+xml": ["xul"], "application/vnd.ms-artgalry": ["cil"], "application/vnd.ms-cab-compressed": ["cab"], "application/vnd.ms-excel": ["xls", "xlm", "xla", "xlc", "xlt", "xlw"], "application/vnd.ms-excel.addin.macroenabled.12": ["xlam"], "application/vnd.ms-excel.sheet.binary.macroenabled.12": ["xlsb"], "application/vnd.ms-excel.sheet.macroenabled.12": ["xlsm"], "application/vnd.ms-excel.template.macroenabled.12": ["xltm"], "application/vnd.ms-fontobject": ["eot"], "application/vnd.ms-htmlhelp": ["chm"], "application/vnd.ms-ims": ["ims"], "application/vnd.ms-lrm": ["lrm"], "application/vnd.ms-officetheme": ["thmx"], "application/vnd.ms-pki.seccat": ["cat"], "application/vnd.ms-pki.stl": ["stl"], "application/vnd.ms-powerpoint": ["ppt", "pps", "pot"], "application/vnd.ms-powerpoint.addin.macroenabled.12": ["ppam"], "application/vnd.ms-powerpoint.presentation.macroenabled.12": ["pptm"], "application/vnd.ms-powerpoint.slide.macroenabled.12": ["sldm"], "application/vnd.ms-powerpoint.slideshow.macroenabled.12": ["ppsm"], "application/vnd.ms-powerpoint.template.macroenabled.12": ["potm"], "application/vnd.ms-project": ["mpp", "mpt"], "application/vnd.ms-word.document.macroenabled.12": ["docm"], "application/vnd.ms-word.template.macroenabled.12": ["dotm"], "application/vnd.ms-works": ["wps", "wks", "wcm", "wdb"], "application/vnd.ms-wpl": ["wpl"], "application/vnd.ms-xpsdocument": ["xps"], "application/vnd.mseq": ["mseq"], "application/vnd.musician": ["mus"], "application/vnd.muvee.style": ["msty"], "application/vnd.mynfc": ["taglet"], "application/vnd.neurolanguage.nlu": ["nlu"], "application/vnd.nitf": ["ntf", "nitf"], "application/vnd.noblenet-directory": ["nnd"], "application/vnd.noblenet-sealer": ["nns"], "application/vnd.noblenet-web": ["nnw"], "application/vnd.nokia.n-gage.data": ["ngdat"], "application/vnd.nokia.n-gage.symbian.install": ["n-gage"], "application/vnd.nokia.radio-preset": ["rpst"], "application/vnd.nokia.radio-presets": ["rpss"], "application/vnd.novadigm.edm": ["edm"], "application/vnd.novadigm.edx": ["edx"], "application/vnd.novadigm.ext": ["ext"], "application/vnd.oasis.opendocument.chart": ["odc"], "application/vnd.oasis.opendocument.chart-template": ["otc"], "application/vnd.oasis.opendocument.database": ["odb"], "application/vnd.oasis.opendocument.formula": ["odf"], "application/vnd.oasis.opendocument.formula-template": ["odft"], "application/vnd.oasis.opendocument.graphics": ["odg"], "application/vnd.oasis.opendocument.graphics-template": ["otg"], "application/vnd.oasis.opendocument.image": ["odi"], "application/vnd.oasis.opendocument.image-template": ["oti"], "application/vnd.oasis.opendocument.presentation": ["odp"], "application/vnd.oasis.opendocument.presentation-template": ["otp"], "application/vnd.oasis.opendocument.spreadsheet": ["ods"], "application/vnd.oasis.opendocument.spreadsheet-template": ["ots"], "application/vnd.oasis.opendocument.text": ["odt"], "application/vnd.oasis.opendocument.text-master": ["odm"], "application/vnd.oasis.opendocument.text-template": ["ott"], "application/vnd.oasis.opendocument.text-web": ["oth"], "application/vnd.olpc-sugar": ["xo"], "application/vnd.oma.dd2+xml": ["dd2"], "application/vnd.openofficeorg.extension": ["oxt"], "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"], "application/vnd.openxmlformats-officedocument.presentationml.slide": ["sldx"], "application/vnd.openxmlformats-officedocument.presentationml.slideshow": ["ppsx"], "application/vnd.openxmlformats-officedocument.presentationml.template": ["potx"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"], "application/vnd.openxmlformats-officedocument.spreadsheetml.template": ["xltx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.template": ["dotx"], "application/vnd.osgeo.mapguide.package": ["mgp"], "application/vnd.osgi.dp": ["dp"], "application/vnd.osgi.subsystem": ["esa"], "application/vnd.palm": ["pdb", "pqa", "oprc"], "application/vnd.pawaafile": ["paw"], "application/vnd.pg.format": ["str"], "application/vnd.pg.osasli": ["ei6"], "application/vnd.picsel": ["efif"], "application/vnd.pmi.widget": ["wg"], "application/vnd.pocketlearn": ["plf"], "application/vnd.powerbuilder6": ["pbd"], "application/vnd.previewsystems.box": ["box"], "application/vnd.proteus.magazine": ["mgz"], "application/vnd.publishare-delta-tree": ["qps"], "application/vnd.pvi.ptid1": ["ptid"], "application/vnd.quark.quarkxpress": ["qxd", "qxt", "qwd", "qwt", "qxl", "qxb"], "application/vnd.realvnc.bed": ["bed"], "application/vnd.recordare.musicxml": ["mxl"], "application/vnd.recordare.musicxml+xml": ["musicxml"], "application/vnd.rig.cryptonote": ["cryptonote"], "application/vnd.rim.cod": ["cod"], "application/vnd.rn-realmedia": ["rm"], "application/vnd.rn-realmedia-vbr": ["rmvb"], "application/vnd.route66.link66+xml": ["link66"], "application/vnd.sailingtracker.track": ["st"], "application/vnd.seemail": ["see"], "application/vnd.sema": ["sema"], "application/vnd.semd": ["semd"], "application/vnd.semf": ["semf"], "application/vnd.shana.informed.formdata": ["ifm"], "application/vnd.shana.informed.formtemplate": ["itp"], "application/vnd.shana.informed.interchange": ["iif"], "application/vnd.shana.informed.package": ["ipk"], "application/vnd.simtech-mindmapper": ["twd", "twds"], "application/vnd.smaf": ["mmf"], "application/vnd.smart.teacher": ["teacher"], "application/vnd.solent.sdkm+xml": ["sdkm", "sdkd"], "application/vnd.spotfire.dxp": ["dxp"], "application/vnd.spotfire.sfs": ["sfs"], "application/vnd.stardivision.calc": ["sdc"], "application/vnd.stardivision.draw": ["sda"], "application/vnd.stardivision.impress": ["sdd"], "application/vnd.stardivision.math": ["smf"], "application/vnd.stardivision.writer": ["sdw", "vor"], "application/vnd.stardivision.writer-global": ["sgl"], "application/vnd.stepmania.package": ["smzip"], "application/vnd.stepmania.stepchart": ["sm"], "application/vnd.sun.xml.calc": ["sxc"], "application/vnd.sun.xml.calc.template": ["stc"], "application/vnd.sun.xml.draw": ["sxd"], "application/vnd.sun.xml.draw.template": ["std"], "application/vnd.sun.xml.impress": ["sxi"], "application/vnd.sun.xml.impress.template": ["sti"], "application/vnd.sun.xml.math": ["sxm"], "application/vnd.sun.xml.writer": ["sxw"], "application/vnd.sun.xml.writer.global": ["sxg"], "application/vnd.sun.xml.writer.template": ["stw"], "application/vnd.sus-calendar": ["sus", "susp"], "application/vnd.svd": ["svd"], "application/vnd.symbian.install": ["sis", "sisx"], "application/vnd.syncml+xml": ["xsm"], "application/vnd.syncml.dm+wbxml": ["bdm"], "application/vnd.syncml.dm+xml": ["xdm"], "application/vnd.tao.intent-module-archive": ["tao"], "application/vnd.tcpdump.pcap": ["pcap", "cap", "dmp"], "application/vnd.tmobile-livetv": ["tmo"], "application/vnd.trid.tpt": ["tpt"], "application/vnd.triscape.mxs": ["mxs"], "application/vnd.trueapp": ["tra"], "application/vnd.ufdl": ["ufd", "ufdl"], "application/vnd.uiq.theme": ["utz"], "application/vnd.umajin": ["umj"], "application/vnd.unity": ["unityweb"], "application/vnd.uoml+xml": ["uoml"], "application/vnd.vcx": ["vcx"], "application/vnd.visio": ["vsd", "vst", "vss", "vsw"], "application/vnd.visionary": ["vis"], "application/vnd.vsf": ["vsf"], "application/vnd.wap.wbxml": ["wbxml"], "application/vnd.wap.wmlc": ["wmlc"], "application/vnd.wap.wmlscriptc": ["wmlsc"], "application/vnd.webturbo": ["wtb"], "application/vnd.wolfram.player": ["nbp"], "application/vnd.wordperfect": ["wpd"], "application/vnd.wqd": ["wqd"], "application/vnd.wt.stf": ["stf"], "application/vnd.xara": ["xar"], "application/vnd.xfdl": ["xfdl"], "application/vnd.yamaha.hv-dic": ["hvd"], "application/vnd.yamaha.hv-script": ["hvs"], "application/vnd.yamaha.hv-voice": ["hvp"], "application/vnd.yamaha.openscoreformat": ["osf"], "application/vnd.yamaha.openscoreformat.osfpvg+xml": ["osfpvg"], "application/vnd.yamaha.smaf-audio": ["saf"], "application/vnd.yamaha.smaf-phrase": ["spf"], "application/vnd.yellowriver-custom-menu": ["cmp"], "application/vnd.zul": ["zir", "zirz"], "application/vnd.zzazz.deck+xml": ["zaz"], "application/voicexml+xml": ["vxml"], "application/widget": ["wgt"], "application/winhlp": ["hlp"], "application/wsdl+xml": ["wsdl"], "application/wspolicy+xml": ["wspolicy"], "application/x-7z-compressed": ["7z"], "application/x-abiword": ["abw"], "application/x-ace-compressed": ["ace"], "application/x-apple-diskimage": ["dmg"], "application/x-authorware-bin": ["aab", "x32", "u32", "vox"], "application/x-authorware-map": ["aam"], "application/x-authorware-seg": ["aas"], "application/x-bcpio": ["bcpio"], "application/x-bdoc": ["bdoc"], "application/x-bittorrent": ["torrent"], "application/x-blorb": ["blb", "blorb"], "application/x-bzip": ["bz"], "application/x-bzip2": ["bz2", "boz"], "application/x-cbr": ["cbr", "cba", "cbt", "cbz", "cb7"], "application/x-cdlink": ["vcd"], "application/x-cfs-compressed": ["cfs"], "application/x-chat": ["chat"], "application/x-chess-pgn": ["pgn"], "application/x-chrome-extension": ["crx"], "application/x-cocoa": ["cco"], "application/x-conference": ["nsc"], "application/x-cpio": ["cpio"], "application/x-csh": ["csh"], "application/x-debian-package": ["deb", "udeb"], "application/x-dgc-compressed": ["dgc"], "application/x-director": ["dir", "dcr", "dxr", "cst", "cct", "cxt", "w3d", "fgd", "swa"], "application/x-doom": ["wad"], "application/x-dtbncx+xml": ["ncx"], "application/x-dtbook+xml": ["dtb"], "application/x-dtbresource+xml": ["res"], "application/x-dvi": ["dvi"], "application/x-envoy": ["evy"], "application/x-eva": ["eva"], "application/x-font-bdf": ["bdf"], "application/x-font-ghostscript": ["gsf"], "application/x-font-linux-psf": ["psf"], "application/x-font-otf": ["otf"], "application/x-font-pcf": ["pcf"], "application/x-font-snf": ["snf"], "application/x-font-ttf": ["ttf", "ttc"], "application/x-font-type1": ["pfa", "pfb", "pfm", "afm"], "application/x-freearc": ["arc"], "application/x-futuresplash": ["spl"], "application/x-gca-compressed": ["gca"], "application/x-glulx": ["ulx"], "application/x-gnumeric": ["gnumeric"], "application/x-gramps-xml": ["gramps"], "application/x-gtar": ["gtar"], "application/x-hdf": ["hdf"], "application/x-httpd-php": ["php"], "application/x-install-instructions": ["install"], "application/x-iso9660-image": ["iso"], "application/x-java-archive-diff": ["jardiff"], "application/x-java-jnlp-file": ["jnlp"], "application/x-latex": ["latex"], "application/x-lua-bytecode": ["luac"], "application/x-lzh-compressed": ["lzh", "lha"], "application/x-makeself": ["run"], "application/x-mie": ["mie"], "application/x-mobipocket-ebook": ["prc", "mobi"], "application/x-ms-application": ["application"], "application/x-ms-shortcut": ["lnk"], "application/x-ms-wmd": ["wmd"], "application/x-ms-wmz": ["wmz"], "application/x-ms-xbap": ["xbap"], "application/x-msaccess": ["mdb"], "application/x-msbinder": ["obd"], "application/x-mscardfile": ["crd"], "application/x-msclip": ["clp"], "application/x-msdos-program": ["exe"], "application/x-msdownload": ["exe", "dll", "com", "bat", "msi"], "application/x-msmediaview": ["mvb", "m13", "m14"], "application/x-msmetafile": ["wmf", "wmz", "emf", "emz"], "application/x-msmoney": ["mny"], "application/x-mspublisher": ["pub"], "application/x-msschedule": ["scd"], "application/x-msterminal": ["trm"], "application/x-mswrite": ["wri"], "application/x-netcdf": ["nc", "cdf"], "application/x-ns-proxy-autoconfig": ["pac"], "application/x-nzb": ["nzb"], "application/x-perl": ["pl", "pm"], "application/x-pilot": ["prc", "pdb"], "application/x-pkcs12": ["p12", "pfx"], "application/x-pkcs7-certificates": ["p7b", "spc"], "application/x-pkcs7-certreqresp": ["p7r"], "application/x-rar-compressed": ["rar"], "application/x-redhat-package-manager": ["rpm"], "application/x-research-info-systems": ["ris"], "application/x-sea": ["sea"], "application/x-sh": ["sh"], "application/x-shar": ["shar"], "application/x-shockwave-flash": ["swf"], "application/x-silverlight-app": ["xap"], "application/x-sql": ["sql"], "application/x-stuffit": ["sit"], "application/x-stuffitx": ["sitx"], "application/x-subrip": ["srt"], "application/x-sv4cpio": ["sv4cpio"], "application/x-sv4crc": ["sv4crc"], "application/x-t3vm-image": ["t3"], "application/x-tads": ["gam"], "application/x-tar": ["tar"], "application/x-tcl": ["tcl", "tk"], "application/x-tex": ["tex"], "application/x-tex-tfm": ["tfm"], "application/x-texinfo": ["texinfo", "texi"], "application/x-tgif": ["obj"], "application/x-ustar": ["ustar"], "application/x-wais-source": ["src"], "application/x-web-app-manifest+json": ["webapp"], "application/x-x509-ca-cert": ["der", "crt", "pem"], "application/x-xfig": ["fig"], "application/x-xliff+xml": ["xlf"], "application/x-xpinstall": ["xpi"], "application/x-xz": ["xz"], "application/x-zmachine": ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"], "application/xaml+xml": ["xaml"], "application/xcap-diff+xml": ["xdf"], "application/xenc+xml": ["xenc"], "application/xhtml+xml": ["xhtml", "xht"], "application/xml": ["xml", "xsl", "xsd", "rng"], "application/xml-dtd": ["dtd"], "application/xop+xml": ["xop"], "application/xproc+xml": ["xpl"], "application/xslt+xml": ["xslt"], "application/xspf+xml": ["xspf"], "application/xv+xml": ["mxml", "xhvml", "xvml", "xvm"], "application/yang": ["yang"], "application/yin+xml": ["yin"], "application/zip": ["zip"], "audio/3gpp": ["3gpp"], "audio/adpcm": ["adp"], "audio/basic": ["au", "snd"], "audio/midi": ["mid", "midi", "kar", "rmi"], "audio/mp3": ["mp3"], "audio/mp4": ["m4a", "mp4a"], "audio/mpeg": ["mpga", "mp2", "mp2a", "mp3", "m2a", "m3a"], "audio/ogg": ["oga", "ogg", "spx"], "audio/s3m": ["s3m"], "audio/silk": ["sil"], "audio/vnd.dece.audio": ["uva", "uvva"], "audio/vnd.digital-winds": ["eol"], "audio/vnd.dra": ["dra"], "audio/vnd.dts": ["dts"], "audio/vnd.dts.hd": ["dtshd"], "audio/vnd.lucent.voice": ["lvp"], "audio/vnd.ms-playready.media.pya": ["pya"], "audio/vnd.nuera.ecelp4800": ["ecelp4800"], "audio/vnd.nuera.ecelp7470": ["ecelp7470"], "audio/vnd.nuera.ecelp9600": ["ecelp9600"], "audio/vnd.rip": ["rip"], "audio/wav": ["wav"], "audio/wave": ["wav"], "audio/webm": ["weba"], "audio/x-aac": ["aac"], "audio/x-aiff": ["aif", "aiff", "aifc"], "audio/x-caf": ["caf"], "audio/x-flac": ["flac"], "audio/x-m4a": ["m4a"], "audio/x-matroska": ["mka"], "audio/x-mpegurl": ["m3u"], "audio/x-ms-wax": ["wax"], "audio/x-ms-wma": ["wma"], "audio/x-pn-realaudio": ["ram", "ra"], "audio/x-pn-realaudio-plugin": ["rmp"], "audio/x-realaudio": ["ra"], "audio/x-wav": ["wav"], "audio/xm": ["xm"], "chemical/x-cdx": ["cdx"], "chemical/x-cif": ["cif"], "chemical/x-cmdf": ["cmdf"], "chemical/x-cml": ["cml"], "chemical/x-csml": ["csml"], "chemical/x-xyz": ["xyz"], "font/opentype": ["otf"], "image/bmp": ["bmp"], "image/cgm": ["cgm"], "image/g3fax": ["g3"], "image/gif": ["gif"], "image/ief": ["ief"], "image/jpeg": ["jpeg", "jpg", "jpe"], "image/ktx": ["ktx"], "image/png": ["png"], "image/prs.btif": ["btif"], "image/sgi": ["sgi"], "image/svg+xml": ["svg", "svgz"], "image/tiff": ["tiff", "tif"], "image/vnd.adobe.photoshop": ["psd"], "image/vnd.dece.graphic": ["uvi", "uvvi", "uvg", "uvvg"], "image/vnd.djvu": ["djvu", "djv"], "image/vnd.dvb.subtitle": ["sub"], "image/vnd.dwg": ["dwg"], "image/vnd.dxf": ["dxf"], "image/vnd.fastbidsheet": ["fbs"], "image/vnd.fpx": ["fpx"], "image/vnd.fst": ["fst"], "image/vnd.fujixerox.edmics-mmr": ["mmr"], "image/vnd.fujixerox.edmics-rlc": ["rlc"], "image/vnd.ms-modi": ["mdi"], "image/vnd.ms-photo": ["wdp"], "image/vnd.net-fpx": ["npx"], "image/vnd.wap.wbmp": ["wbmp"], "image/vnd.xiff": ["xif"], "image/webp": ["webp"], "image/x-3ds": ["3ds"], "image/x-cmu-raster": ["ras"], "image/x-cmx": ["cmx"], "image/x-freehand": ["fh", "fhc", "fh4", "fh5", "fh7"], "image/x-icon": ["ico"], "image/x-jng": ["jng"], "image/x-mrsid-image": ["sid"], "image/x-ms-bmp": ["bmp"], "image/x-pcx": ["pcx"], "image/x-pict": ["pic", "pct"], "image/x-portable-anymap": ["pnm"], "image/x-portable-bitmap": ["pbm"], "image/x-portable-graymap": ["pgm"], "image/x-portable-pixmap": ["ppm"], "image/x-rgb": ["rgb"], "image/x-tga": ["tga"], "image/x-xbitmap": ["xbm"], "image/x-xpixmap": ["xpm"], "image/x-xwindowdump": ["xwd"], "message/rfc822": ["eml", "mime"], "model/iges": ["igs", "iges"], "model/mesh": ["msh", "mesh", "silo"], "model/vnd.collada+xml": ["dae"], "model/vnd.dwf": ["dwf"], "model/vnd.gdl": ["gdl"], "model/vnd.gtw": ["gtw"], "model/vnd.mts": ["mts"], "model/vnd.vtu": ["vtu"], "model/vrml": ["wrl", "vrml"], "model/x3d+binary": ["x3db", "x3dbz"], "model/x3d+vrml": ["x3dv", "x3dvz"], "model/x3d+xml": ["x3d", "x3dz"], "text/cache-manifest": ["appcache", "manifest"], "text/calendar": ["ics", "ifb"], "text/coffeescript": ["coffee", "litcoffee"], "text/css": ["css"], "text/csv": ["csv"], "text/hjson": ["hjson"], "text/html": ["html", "htm", "shtml"], "text/jade": ["jade"], "text/jsx": ["jsx"], "text/less": ["less"], "text/mathml": ["mml"], "text/n3": ["n3"], "text/plain": ["txt", "text", "conf", "def", "list", "log", "in", "ini"], "text/prs.lines.tag": ["dsc"], "text/richtext": ["rtx"], "text/rtf": ["rtf"], "text/sgml": ["sgml", "sgm"], "text/slim": ["slim", "slm"], "text/stylus": ["stylus", "styl"], "text/tab-separated-values": ["tsv"], "text/troff": ["t", "tr", "roff", "man", "me", "ms"], "text/turtle": ["ttl"], "text/uri-list": ["uri", "uris", "urls"], "text/vcard": ["vcard"], "text/vnd.curl": ["curl"], "text/vnd.curl.dcurl": ["dcurl"], "text/vnd.curl.mcurl": ["mcurl"], "text/vnd.curl.scurl": ["scurl"], "text/vnd.dvb.subtitle": ["sub"], "text/vnd.fly": ["fly"], "text/vnd.fmi.flexstor": ["flx"], "text/vnd.graphviz": ["gv"], "text/vnd.in3d.3dml": ["3dml"], "text/vnd.in3d.spot": ["spot"], "text/vnd.sun.j2me.app-descriptor": ["jad"], "text/vnd.wap.wml": ["wml"], "text/vnd.wap.wmlscript": ["wmls"], "text/vtt": ["vtt"], "text/x-asm": ["s", "asm"], "text/x-c": ["c", "cc", "cxx", "cpp", "h", "hh", "dic"], "text/x-component": ["htc"], "text/x-fortran": ["f", "for", "f77", "f90"], "text/x-handlebars-template": ["hbs"], "text/x-java-source": ["java"], "text/x-lua": ["lua"], "text/x-markdown": ["markdown", "md", "mkd"], "text/x-nfo": ["nfo"], "text/x-opml": ["opml"], "text/x-pascal": ["p", "pas"], "text/x-processing": ["pde"], "text/x-sass": ["sass"], "text/x-scss": ["scss"], "text/x-setext": ["etx"], "text/x-sfv": ["sfv"], "text/x-suse-ymp": ["ymp"], "text/x-uuencode": ["uu"], "text/x-vcalendar": ["vcs"], "text/x-vcard": ["vcf"], "text/xml": ["xml"], "text/yaml": ["yaml", "yml"], "video/3gpp": ["3gp", "3gpp"], "video/3gpp2": ["3g2"], "video/h261": ["h261"], "video/h263": ["h263"], "video/h264": ["h264"], "video/jpeg": ["jpgv"], "video/jpm": ["jpm", "jpgm"], "video/mj2": ["mj2", "mjp2"], "video/mp2t": ["ts"], "video/mp4": ["mp4", "mp4v", "mpg4"], "video/mpeg": ["mpeg", "mpg", "mpe", "m1v", "m2v"], "video/ogg": ["ogv"], "video/quicktime": ["qt", "mov"], "video/vnd.dece.hd": ["uvh", "uvvh"], "video/vnd.dece.mobile": ["uvm", "uvvm"], "video/vnd.dece.pd": ["uvp", "uvvp"], "video/vnd.dece.sd": ["uvs", "uvvs"], "video/vnd.dece.video": ["uvv", "uvvv"], "video/vnd.dvb.file": ["dvb"], "video/vnd.fvt": ["fvt"], "video/vnd.mpegurl": ["mxu", "m4u"], "video/vnd.ms-playready.media.pyv": ["pyv"], "video/vnd.uvvu.mp4": ["uvu", "uvvu"], "video/vnd.vivo": ["viv"], "video/webm": ["webm"], "video/x-f4v": ["f4v"], "video/x-fli": ["fli"], "video/x-flv": ["flv"], "video/x-m4v": ["m4v"], "video/x-matroska": ["mkv", "mk3d", "mks"], "video/x-mng": ["mng"], "video/x-ms-asf": ["asf", "asx"], "video/x-ms-vob": ["vob"], "video/x-ms-wm": ["wm"], "video/x-ms-wmv": ["wmv"], "video/x-ms-wmx": ["wmx"], "video/x-ms-wvx": ["wvx"], "video/x-msvideo": ["avi"], "video/x-sgi-movie": ["movie"], "video/x-smv": ["smv"], "x-conference/x-cooltalk": ["ice"] };
        }, {}], 2: [function (require, module, exports) {
            (function (process) {
                var path = require('path');
                var fs = require('fs');

                function Mime() {
                    // Map of extension -> mime type
                    this.types = Object.create(null);

                    // Map of mime type -> extension
                    this.extensions = Object.create(null);
                }

                /**
                 * Define mimetype -> extension mappings.  Each key is a mime-type that maps
                 * to an array of extensions associated with the type.  The first extension is
                 * used as the default extension for the type.
                 *
                 * e.g. mime.define({'audio/ogg', ['oga', 'ogg', 'spx']});
                 *
                 * @param map (Object) type definitions
                 */
                Mime.prototype.define = function (map) {
                    for (var type in map) {
                        var exts = map[type];
                        for (var i = 0; i < exts.length; i++) {
                            if (process.env.DEBUG_MIME && this.types[exts[i]]) {
                                console.warn((this._loading || "define()").replace(/.*\//, ''), 'changes "' + exts[i] + '" extension type from ' + this.types[exts[i]] + ' to ' + type);
                            }

                            this.types[exts[i]] = type;
                        }

                        // Default extension is the first one we encounter
                        if (!this.extensions[type]) {
                            this.extensions[type] = exts[0];
                        }
                    }
                };

                /**
                 * Load an Apache2-style ".types" file
                 *
                 * This may be called multiple times (it's expected).  Where files declare
                 * overlapping types/extensions, the last file wins.
                 *
                 * @param file (String) path of file to load.
                 */
                Mime.prototype.load = function (file) {
                    this._loading = file;
                    // Read file and split into lines
                    var map = {},
                        content = fs.readFileSync(file, 'ascii'),
                        lines = content.split(/[\r\n]+/);

                    lines.forEach(function (line) {
                        // Clean up whitespace/comments, and split into fields
                        var fields = line.replace(/\s*#.*|^\s*|\s*$/g, '').split(/\s+/);
                        map[fields.shift()] = fields;
                    });

                    this.define(map);

                    this._loading = null;
                };

                /**
                 * Lookup a mime type based on extension
                 */
                Mime.prototype.lookup = function (path, fallback) {
                    var ext = path.replace(/.*[\.\/\\]/, '').toLowerCase();

                    return this.types[ext] || fallback || this.default_type;
                };

                /**
                 * Return file extension associated with a mime type
                 */
                Mime.prototype.extension = function (mimeType) {
                    var type = mimeType.match(/^\s*([^;\s]*)(?:;|\s|$)/)[1].toLowerCase();
                    return this.extensions[type];
                };

                // Default instance
                var mime = new Mime();

                // Define built-in types
                mime.define(require('./types.json'));

                // Default type
                mime.default_type = mime.lookup('bin');

                //
                // Additional API specific to the default instance
                //

                mime.Mime = Mime;

                /**
                 * Lookup a charset based on mime type.
                 */
                mime.charsets = {
                    lookup: function (mimeType, fallback) {
                        // Assume text types are utf8
                        return (/^text\/|^application\/(javascript|json)/.test(mimeType) ? 'UTF-8' : fallback
                        );
                    }
                };

                module.exports = mime;
            }).call(this, require('_process'));
        }, { "./types.json": 1, "_process": 5, "fs": 3, "path": 4 }], 3: [function (require, module, exports) {}, {}], 4: [function (require, module, exports) {
            (function (process) {
                // Copyright Joyent, Inc. and other Node contributors.
                //
                // Permission is hereby granted, free of charge, to any person obtaining a
                // copy of this software and associated documentation files (the
                // "Software"), to deal in the Software without restriction, including
                // without limitation the rights to use, copy, modify, merge, publish,
                // distribute, sublicense, and/or sell copies of the Software, and to permit
                // persons to whom the Software is furnished to do so, subject to the
                // following conditions:
                //
                // The above copyright notice and this permission notice shall be included
                // in all copies or substantial portions of the Software.
                //
                // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
                // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
                // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
                // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
                // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
                // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
                // USE OR OTHER DEALINGS IN THE SOFTWARE.

                // resolves . and .. elements in a path array with directory names there
                // must be no slashes, empty elements, or device names (c:\) in the array
                // (so also no leading and trailing slashes - it does not distinguish
                // relative and absolute paths)
                function normalizeArray(parts, allowAboveRoot) {
                    // if the path tries to go above the root, `up` ends up > 0
                    var up = 0;
                    for (var i = parts.length - 1; i >= 0; i--) {
                        var last = parts[i];
                        if (last === '.') {
                            parts.splice(i, 1);
                        } else if (last === '..') {
                            parts.splice(i, 1);
                            up++;
                        } else if (up) {
                            parts.splice(i, 1);
                            up--;
                        }
                    }

                    // if the path is allowed to go above the root, restore leading ..s
                    if (allowAboveRoot) {
                        for (; up--; up) {
                            parts.unshift('..');
                        }
                    }

                    return parts;
                }

                // Split a filename into [root, dir, basename, ext], unix version
                // 'root' is just a slash, or nothing.
                var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
                var splitPath = function (filename) {
                    return splitPathRe.exec(filename).slice(1);
                };

                // path.resolve([from ...], to)
                // posix version
                exports.resolve = function () {
                    var resolvedPath = '',
                        resolvedAbsolute = false;

                    for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
                        var path = i >= 0 ? arguments[i] : process.cwd();

                        // Skip empty and invalid entries
                        if (typeof path !== 'string') {
                            throw new TypeError('Arguments to path.resolve must be strings');
                        } else if (!path) {
                            continue;
                        }

                        resolvedPath = path + '/' + resolvedPath;
                        resolvedAbsolute = path.charAt(0) === '/';
                    }

                    // At this point the path should be resolved to a full absolute path, but
                    // handle relative paths to be safe (might happen when process.cwd() fails)

                    // Normalize the path
                    resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function (p) {
                        return !!p;
                    }), !resolvedAbsolute).join('/');

                    return (resolvedAbsolute ? '/' : '') + resolvedPath || '.';
                };

                // path.normalize(path)
                // posix version
                exports.normalize = function (path) {
                    var isAbsolute = exports.isAbsolute(path),
                        trailingSlash = substr(path, -1) === '/';

                    // Normalize the path
                    path = normalizeArray(filter(path.split('/'), function (p) {
                        return !!p;
                    }), !isAbsolute).join('/');

                    if (!path && !isAbsolute) {
                        path = '.';
                    }
                    if (path && trailingSlash) {
                        path += '/';
                    }

                    return (isAbsolute ? '/' : '') + path;
                };

                // posix version
                exports.isAbsolute = function (path) {
                    return path.charAt(0) === '/';
                };

                // posix version
                exports.join = function () {
                    var paths = Array.prototype.slice.call(arguments, 0);
                    return exports.normalize(filter(paths, function (p, index) {
                        if (typeof p !== 'string') {
                            throw new TypeError('Arguments to path.join must be strings');
                        }
                        return p;
                    }).join('/'));
                };

                // path.relative(from, to)
                // posix version
                exports.relative = function (from, to) {
                    from = exports.resolve(from).substr(1);
                    to = exports.resolve(to).substr(1);

                    function trim(arr) {
                        var start = 0;
                        for (; start < arr.length; start++) {
                            if (arr[start] !== '') break;
                        }

                        var end = arr.length - 1;
                        for (; end >= 0; end--) {
                            if (arr[end] !== '') break;
                        }

                        if (start > end) return [];
                        return arr.slice(start, end - start + 1);
                    }

                    var fromParts = trim(from.split('/'));
                    var toParts = trim(to.split('/'));

                    var length = Math.min(fromParts.length, toParts.length);
                    var samePartsLength = length;
                    for (var i = 0; i < length; i++) {
                        if (fromParts[i] !== toParts[i]) {
                            samePartsLength = i;
                            break;
                        }
                    }

                    var outputParts = [];
                    for (var i = samePartsLength; i < fromParts.length; i++) {
                        outputParts.push('..');
                    }

                    outputParts = outputParts.concat(toParts.slice(samePartsLength));

                    return outputParts.join('/');
                };

                exports.sep = '/';
                exports.delimiter = ':';

                exports.dirname = function (path) {
                    var result = splitPath(path),
                        root = result[0],
                        dir = result[1];

                    if (!root && !dir) {
                        // No dirname whatsoever
                        return '.';
                    }

                    if (dir) {
                        // It has a dirname, strip trailing slash
                        dir = dir.substr(0, dir.length - 1);
                    }

                    return root + dir;
                };

                exports.basename = function (path, ext) {
                    var f = splitPath(path)[2];
                    // TODO: make this comparison case-insensitive on windows?
                    if (ext && f.substr(-1 * ext.length) === ext) {
                        f = f.substr(0, f.length - ext.length);
                    }
                    return f;
                };

                exports.extname = function (path) {
                    return splitPath(path)[3];
                };

                function filter(xs, f) {
                    if (xs.filter) return xs.filter(f);
                    var res = [];
                    for (var i = 0; i < xs.length; i++) {
                        if (f(xs[i], i, xs)) res.push(xs[i]);
                    }
                    return res;
                }

                // String.prototype.substr - negative index don't work in IE8
                var substr = 'ab'.substr(-1) === 'b' ? function (str, start, len) {
                    return str.substr(start, len);
                } : function (str, start, len) {
                    if (start < 0) start = str.length + start;
                    return str.substr(start, len);
                };
            }).call(this, require('_process'));
        }, { "_process": 5 }], 5: [function (require, module, exports) {
            // shim for using process in browser
            var process = module.exports = {};

            // cached from whatever global is present so that test runners that stub it
            // don't break things.  But we need to wrap it in a try catch in case it is
            // wrapped in strict mode code which doesn't define any globals.  It's inside a
            // function because try/catches deoptimize in certain engines.

            var cachedSetTimeout;
            var cachedClearTimeout;

            function defaultSetTimout() {
                throw new Error('setTimeout has not been defined');
            }
            function defaultClearTimeout() {
                throw new Error('clearTimeout has not been defined');
            }
            (function () {
                try {
                    if (typeof setTimeout === 'function') {
                        cachedSetTimeout = setTimeout;
                    } else {
                        cachedSetTimeout = defaultSetTimout;
                    }
                } catch (e) {
                    cachedSetTimeout = defaultSetTimout;
                }
                try {
                    if (typeof clearTimeout === 'function') {
                        cachedClearTimeout = clearTimeout;
                    } else {
                        cachedClearTimeout = defaultClearTimeout;
                    }
                } catch (e) {
                    cachedClearTimeout = defaultClearTimeout;
                }
            })();
            function runTimeout(fun) {
                if (cachedSetTimeout === setTimeout) {
                    //normal enviroments in sane situations
                    return setTimeout(fun, 0);
                }
                // if setTimeout wasn't available but was latter defined
                if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
                    cachedSetTimeout = setTimeout;
                    return setTimeout(fun, 0);
                }
                try {
                    // when when somebody has screwed with setTimeout but no I.E. maddness
                    return cachedSetTimeout(fun, 0);
                } catch (e) {
                    try {
                        // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
                        return cachedSetTimeout.call(null, fun, 0);
                    } catch (e) {
                        // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
                        return cachedSetTimeout.call(this, fun, 0);
                    }
                }
            }
            function runClearTimeout(marker) {
                if (cachedClearTimeout === clearTimeout) {
                    //normal enviroments in sane situations
                    return clearTimeout(marker);
                }
                // if clearTimeout wasn't available but was latter defined
                if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
                    cachedClearTimeout = clearTimeout;
                    return clearTimeout(marker);
                }
                try {
                    // when when somebody has screwed with setTimeout but no I.E. maddness
                    return cachedClearTimeout(marker);
                } catch (e) {
                    try {
                        // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
                        return cachedClearTimeout.call(null, marker);
                    } catch (e) {
                        // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
                        // Some versions of I.E. have different rules for clearTimeout vs setTimeout
                        return cachedClearTimeout.call(this, marker);
                    }
                }
            }
            var queue = [];
            var draining = false;
            var currentQueue;
            var queueIndex = -1;

            function cleanUpNextTick() {
                if (!draining || !currentQueue) {
                    return;
                }
                draining = false;
                if (currentQueue.length) {
                    queue = currentQueue.concat(queue);
                } else {
                    queueIndex = -1;
                }
                if (queue.length) {
                    drainQueue();
                }
            }

            function drainQueue() {
                if (draining) {
                    return;
                }
                var timeout = runTimeout(cleanUpNextTick);
                draining = true;

                var len = queue.length;
                while (len) {
                    currentQueue = queue;
                    queue = [];
                    while (++queueIndex < len) {
                        if (currentQueue) {
                            currentQueue[queueIndex].run();
                        }
                    }
                    queueIndex = -1;
                    len = queue.length;
                }
                currentQueue = null;
                draining = false;
                runClearTimeout(timeout);
            }

            process.nextTick = function (fun) {
                var args = new Array(arguments.length - 1);
                if (arguments.length > 1) {
                    for (var i = 1; i < arguments.length; i++) {
                        args[i - 1] = arguments[i];
                    }
                }
                queue.push(new Item(fun, args));
                if (queue.length === 1 && !draining) {
                    runTimeout(drainQueue);
                }
            };

            // v8 likes predictible objects
            function Item(fun, array) {
                this.fun = fun;
                this.array = array;
            }
            Item.prototype.run = function () {
                this.fun.apply(null, this.array);
            };
            process.title = 'browser';
            process.browser = true;
            process.env = {};
            process.argv = [];
            process.version = ''; // empty string to avoid regexp issues
            process.versions = {};

            function noop() {}

            process.on = noop;
            process.addListener = noop;
            process.once = noop;
            process.off = noop;
            process.removeListener = noop;
            process.removeAllListeners = noop;
            process.emit = noop;

            process.binding = function (name) {
                throw new Error('process.binding is not supported');
            };

            process.cwd = function () {
                return '/';
            };
            process.chdir = function (dir) {
                throw new Error('process.chdir is not supported');
            };
            process.umask = function () {
                return 0;
            };
        }, {}] }, {}, [2])(2);
});

// Because sometimes you have to write somethign yourself to make it right.

var EventEmitter = class {
  constructor() {
    this.listeners = new Map();
    this.onceListeners = new Map();
    this.others = new Set();
  }

  on(namespace, callback) {
    let set = this.listeners.get(namespace);
    if (!set) {
      set = new Set();
      this.listeners.set(namespace, set);
    }
    set.add(callback);
  }
  addEventListener(namespace, callback) {
    this.on(namespace, callback);
  }

  off(namespace, callback) {
    if (callback) {
      this.listeners.get(namespace).delete(callback);
    } else {
      this.listeners.delete(namespace);
    }
  }
  removeEventListener(namespace, callback) {
    this.off(namespace, callback);
  }

  once(namespace, callback) {
    let set = this.onceListeners.get(namespace);
    if (!set) {
      set = new Set();
      this.onceListeners.set(namespace, set);
    }
    set.add(callback);
  }

  emit(namespace, data) {
    let set = this.listeners.get(namespace) || [];
    for (let callback of set) {
      callback(data);
    }
    let onceSet = this.onceListeners.get(namespace) || [];
    for (let callback of onceSet) {
      callback(data);
      onceSet.delete(callback);
    }
  }
  postMessage(namespace, data) {
    this.emit(namespace, data);
  }
};

// Step 1. Setup BrowserFS
importScripts('https://unpkg.com/browserfs@1.4.3/dist/browserfs.js');
//importScripts('https://cdnjs.cloudflare.com/ajax/libs/eventemitter3/2.0.3/index.min.js')
const fsReady = new Promise(function (resolve, reject) {
  BrowserFS.configure({
    fs: "MountableFileSystem",
    options: {
      "/": {
        fs: "IndexedDB",
        options: {}
      }
    }
  }, err => err ? reject(err) : resolve());
});
// Step 2. Export fs
let fs = BrowserFS.BFSRequire('fs');
// Wrap fs so we can monitor all file operations
fs.Events = new EventEmitter();

function emit(propKey, ...args) {
  switch (propKey) {
    case 'writeFile':
    case 'writeFileSync':
      return fs.Events.emit('write', {
        eventType: 'write',
        filepath: args[0]
      });
    case 'mkdir':
    case 'mkdirSync':
      return fs.Events.emit('mkdir', {
        eventType: 'mkdir',
        filepath: args[0]
      });
    case 'unlink':
    case 'unlinkSync':
      fs.Events.emit('unlink', {
        eventType: 'unlink',
        filepath: args[0]
      });
      return;
    case 'rmdir':
    case 'rmdirSync':
      return fs.Events.emit('rmdir', {
        eventType: 'rmdir',
        filepath: args[0]
      });
    case 'rename':
    case 'renameSync':
      return fs.Events.emit('rename', {
        eventType: 'rename',
        from: args[0],
        to: args[1]
      });
    default:
      return;
  }
}

function traceMethodCalls(obj) {
  const handler = {
    get(target, propKey, receiver) {
      const targetValue = Reflect.get(target, propKey, receiver);
      if (typeof targetValue === 'function') {
        return function (...args) {
          for (let i in args) {
            if (typeof args[i] === 'function') {
              let _callback = args[i];
              args[i] = function (...cbargs) {
                _callback(...cbargs);
                if (!cbargs[0]) {
                  console.log('CALLBACK', propKey, args, cbargs);
                  emit(propKey, ...args);
                }
              };
            }
          }
          let result = targetValue.apply(this, args); // (A)
          if (propKey.endsWith('Sync')) {
            console.log('CALLED', propKey, args, result);
            // fs.Events.emit('change', {
            //   eventType: 'change',
            //   filename: file
            // })
          }
          return result;
        };
      } else {
        return targetValue;
      }
    }
  };
  return new Proxy(obj, handler);
}

fs = traceMethodCalls(fs);

function useMyFilesystem(obj) {
  const handler = {
    get(target, propKey, receiver) {
      const targetValue = Reflect.get(target, propKey, receiver);
      if (typeof targetValue === 'function') {
        return function (...args) {
          // I reject your "fs" and substitute my own.
          if (args.length > 0 && typeof args[0] === 'object') {
            args[0] = new git.Git(Object.assign(args[0], { fs }));
          }
          let result = targetValue.apply(this, args);
          return result;
        };
      } else {
        return targetValue;
      }
    }
  };
  return new Proxy(obj, handler);
}

// Because isaacs "rimraf" is too Node-specific
const pfy = function (fn) {
  return function (a, cb) {
    return new Promise(function (resolve, reject) {
      fn(a, (err, result) => err ? reject(err) : resolve(result));
    });
  };
};

const readdir = pfy(fs.readdir.bind(fs));
const unlink = pfy(fs.unlink.bind(fs));
const rmdir = pfy(fs.rmdir.bind(fs));

// It's elegant in it's naivety
async function rimraf(path) {
  try {
    // First assume path is itself a file
    await unlink(path);
    // if that worked we're done
    return;
  } catch (err) {
    // Otherwise, path must be a directory
    if (err.code !== 'EISDIR') throw err;
  }
  // Knowing path is a directory,
  // first, assume everything inside path is a file.
  let files = await readdir(path);
  for (let file of files) {
    let child = path + '/' + file;
    try {
      await fs.unlink(child);
    } catch (err) {
      if (err.code !== 'EISDIR') throw err;
    }
  }
  // Assume what's left are directories and recurse.
  let dirs = await readdir(path);
  for (let dir of dirs) {
    let child = path + '/' + dir;
    await rimraf(child);
  }
  // Finally, delete the empty directory
  await rmdir(path);
}

const toPaths = dirname => {
  let pieces = dirname.replace(/^\//, '').split('/').filter(x => x !== '');
  pieces.unshift('');
  let paths = [];
  let fullpath = '';
  for (let piece of pieces) {
    fullpath += '/' + piece;
    paths.push({
      name: piece,
      url: fullpath.replace(/^\//, '')
    });
  }
  // terrible hack
  if (paths.length === 1) {
    paths[0].name = '/';
  }
  return paths;
};

const toFiles = (dirname, files) => files.map(filename => ({
  ext: OmniPath.ext(filename).replace(/^\./, ''),
  base: OmniPath.base(filename),
  relative: OmniPath.join(dirname, filename),
  title: OmniPath.base(filename),
  size: '? mb'
}));

function renderIndex(dirname, dirlist) {
  let directory = dirname;
  let paths = toPaths(directory);
  let files = toFiles(directory, dirlist);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  
  <title>Files within ${directory}</title>
  
  <style>
  body {
    background: #fff;
    margin: 0;
    padding: 30px;
    -webkit-font-smoothing: antialiased;
    font-family: Menlo, Consolas, monospace;
  }
  
  main {
    max-width: 920px;
  }
  
  a {
    color: #1A00F2;
    text-decoration: none;
  }
  
  h1 {
    font-size: 18px;
    font-weight: 500;
    margin-top: 0;
    color: #000;
    font-family: -apple-system, Helvetica;
    display: flex;
  }
  
  h1 a {
    color: inherit;
    font-weight: bold;
    border-bottom: 1px dashed transparent;
  }
  
  h1 a::after {
    content: '/';
  }
  
  h1 a:last-of-type::after {
    content: '';
  }
  
  h1 a:hover {
    color: #7d7d7d;
  }
  
  h1 i {
    font-style: normal;
  }
  
  ul {
    margin: 0;
    padding: 20px 0 0 0;
  }
  
  ul li {
    list-style: none;
    padding: 10px 0;
    font-size: 14px;
    display: flex;
    justify-content: space-between;
  }
  
  ul li i {
    color: #9B9B9B;
    font-size: 11px;
    display: block;
    font-style: normal;
    white-space: nowrap;
    padding-left: 15px;
  }
  
  ul a {
    color: #1A00F2;
    white-space: nowrap;
    overflow: hidden;
    display: block;
    text-overflow: ellipsis;
  }
  
  /* file-icon – svg inlined here, but it should also be possible to separate out. */
  ul a::before {
    content: url("data:image/svg+xml; utf8, <svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 64 64'><g><path fill='transparent' stroke='currentColor' stroke-width='4px' stroke-miterlimit='10' d='M50.46,56H13.54V8H35.85a4.38,4.38,0,0,1,3.1,1.28L49.18,19.52a4.38,4.38,0,0,1,1.28,3.1Z'/><polyline fill='transparent' stroke='currentColor' stroke-width='2px' stroke-miterlimit='10' points='35.29 8.31 35.29 23.03 49.35 23.03'/></g></svg>");
    display: inline-block;
    vertical-align: middle;
    margin-right: 10px;
  }
  
  ul a:hover {
    color: #000;
  }
  
  ul a[class=''] + i {
    display: none;
  }
  
  /* folder-icon */
  ul a[class='']::before {
    content: url("data:image/svg+xml; utf8, <svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 64 64'><path fill='transparent' stroke='currentColor' stroke-width='4px' stroke-miterlimit='10' d='M56,53.71H8.17L8,21.06a2.13,2.13,0,0,1,2.13-2.13h2.33l2.13-4.28A4.78,4.78,0,0,1,18.87,12h9.65a4.78,4.78,0,0,1,4.28,2.65l2.13,4.28H52.29a3.55,3.55,0,0,1,3.55,3.55Z'/></svg>");
  }
  
  @media (min-width: 768px) {
    ul {
      display: flex;
      flex-wrap: wrap;
    }
    
    ul li {
      width: 230px;
      padding-right: 20px;
    }
  }
  
  @media (min-width: 992px) {
    body {
      padding: 45px;
    }
    
    h1 {
      font-size: 15px;
    }
    
    ul li {
      font-size: 13px;
      box-sizing: border-box;
      justify-content: flex-start;
    }
    
    ul li:hover i {
      opacity: 1;
    }
    
    ul li i {
      font-size: 10px;
      opacity: 0;
      margin-left: 10px;
      margin-top: 3px;
      padding-left: 0;
    }
  }
  </style>
</head>

<body>
  <main>
    <h1>
      <i>Index of&nbsp;</i>
${paths.map(({ url, name }) => `
        <a href="${url}/">${name}</a>`).join('')}
    </h1>
    
    <ul>
${files.map(({ relative, title, ext, base, size }) => `
      <li>
        <a href="${relative}${ext ? '' : '/'}" title="${title}" class="${ext}">${base}</a>
        <i>${size}</i>
      </li>`).join('')}
    </ul>
  </main>
</body>
</html>`;
}

async function serve(path) {
  await fsReady;
  return new Promise(function (resolve, reject) {
    fs.stat(path, (err, stats) => {
      if (err) {
        if (err.code === 'ENOENT') {
          console.log('return with a 404');
          return resolve(new Response(err.message, {
            status: 404,
            statusText: "Not Found"
          }));
        } else {
          return resolve(new Response(err.message, {
            status: 500,
            statusText: "Internal ServiceWorker Error"
          }));
        }
      } else if (stats.isDirectory()) {
        // If the directory doesn't end in a slash, redirect it
        // because otherwise relative URLs will have trouble.
        if (!path.endsWith('/')) return resolve(Response.redirect(path + '/', 302));
        fs.readdir(path, (err, data) => {
          if (err) {
            return resolve(new Response(err.message, {
              status: 500,
              statusText: "Internal ServiceWorker Error"
            }));
          }
          // Serve directory/index.html if it exists
          if (data.includes('index.html')) {
            fs.readFile(`${path}/index.html`, (err, data) => {
              if (err) {
                return resolve(new Response(err.message, {
                  status: 500,
                  statusText: "Internal ServiceWorker Error"
                }));
              }
              return resolve(new Response(data, {
                headers: {
                  'Content-Type': 'text/html'
                }
              }));
            });
          } else {
            // If it doesn't exist, generate a directory index
            try {
              data = renderIndex(path, data);
            } catch (err) {
              return resolve(new Response(err.message, {
                status: 500,
                statusText: "Internal ServiceWorker Error"
              }));
            }
            return resolve(new Response(data, {
              headers: {
                'Content-Type': 'text/html'
              }
            }));
          }
        });
      } else {
        fs.readFile(path, (err, data) => {
          if (err) {
            return resolve(new Response(err.message, {
              status: 500,
              statusText: "Internal ServiceWorker Error"
            }));
          }
          return resolve(new Response(data, {
            headers: {
              'Content-Type': mime.lookup(path)
            }
          }));
        });
      }
    });
  });
}

global = self;
window = global;
importScripts('https://unpkg.com/omnipath@1.1.5/dist/omnipath.min.js');
importScripts('https://gundb-git-app-manager.herokuapp.com/gun.js');
importScripts('https://unpkg.com/isomorphic-git@0.0.31/dist/service-worker-bundle.umd.min.js');
global.fs = fs;
console.log('fs =', fs);
console.log('git =', git);
console.log('OmniPath =', OmniPath);
console.log('gun =', Gun);

let API = {
  fs: pify(fs),
  Events: fs.Events,
  git: useMyFilesystem(git)
  // git: {
  //   async init (args) {
  //     let {dir, gitdir, workdir} = args
  //     console.log({fs, dir, gitdir, workdir}, args)
  //     return git.init(new git.Git({fs, dir, gitdir, workdir}), args)
  //   },
  //   async clone (args) {
  //     let {dir, gitdir, workdir} = args
  //     return git.clone(new git.Git({fs, dir, gitdir, workdir}), args)
  //   }
  // }
};
self.API = API;

// for fun
fs.Events.once('foobar', function (data) {
  console.log('foobar = ', data);
});

async function getGun() {
  global.gun = Gun(['https://gundb-git-app-manager.herokuapp.com/gun']);
  return global.gun;
}

async function getUUID() {
  await fsReady;
  return await new Promise((resolve, reject) => {
    fs.readFile('.uuid', 'utf8', async (err, contents) => {
      if (typeof contents === 'string' && contents.length > 1) return resolve(contents);
      if (err.code === 'ENOENT') {
        let gun = await getGun();
        let uuid = gun._.opt.uuid();
        let me = gun.get(`client/${uuid}`).put({ birthdate: Date.now() });
        gun.get('clients').set(me);
        fs.writeFile('/.uuid', uuid, 'utf8', err => err ? reject(err) : resolve(uuid));
      } else {
        reject(err);
      }
    });
  });
}

async function clone({ ref, repo, name }) {
  await fsReady;
  function handleProgress(e) {
    let msg = {
      type: 'status',
      status: 'progress',
      regarding: { ref, repo, name },
      progress: e.loaded / e.total
    };
    global.clients.matchAll({ includeUncontrolled: true }).then(all => all.map(client => client.postMessage(msg)));
  }

  let dir = name;
  return git.clone(new git.Git({ fs, dir }), {
    depth: 1,
    ref: ref,
    onprogress: handleProgress,
    url: `https://cors-buster-jfpactjnem.now.sh/github.com/${repo}`
  });
}

async function UpdatedDirectoryList(event) {
  await fsReady;
  return new Promise(function (resolve, reject) {
    fs.readdir('/', (err, files) => {
      files = files.filter(x => !x.startsWith('.')).filter(x => x !== 'index.html');
      let msg = {
        type: 'UpdatedDirectoryList',
        regarding: event.data,
        list: files
      };
      self.clients.matchAll({ includeUncontrolled: true }).then(all => all.map(client => client.postMessage(msg)));
      resolve();
    });
  });
}

self.addEventListener('install', event => {
  return event.waitUntil((async () => {
    await fsReady;
    let res = await fetch('/index.html');
    let text = await res.text();
    await new Promise(function (resolve, reject) {
      fs.writeFile('/index.html', text, 'utf8', err => err ? reject(err) : resolve());
    });
    let uuid = await getUUID();
    console.log(uuid);
    console.log('skipWaiting()');
    await self.skipWaiting();
    console.log('skipWaiting() complete');
  })());
});

self.addEventListener('activate', event => {
  return event.waitUntil((async () => {
    await fsReady;
    console.log('claim()');
    await self.clients.claim();
    console.log('claim() complete');
  })());
});

self.addEventListener('message', async event => {
  await fsReady;
  console.log(event.data);
  if (event.data.type === 'comlink/expose') {
    console.log(event.ports[0].postMessage);
    // Comlink.expose(myfs, event.ports[0]);
    Comlink.expose(self.API[event.data.name], event.ports[0]);
  } else if (event.data.type === 'clone') {
    clone(event.data).then(async () => {
      console.log('Done cloning.');
      // Tell all local browser windows and workers the clone is complete.
      let msg = {
        type: 'status',
        status: 'complete',
        regarding: event.data
      };
      console.log('event =', event);
      // Tell all the peers that we have a copy of this repository.
      let gun = await getGun();
      let uuid = await getUUID();
      gun.get(`client/${uuid}`).val(me => {
        console.log('me = ', me);
        gun.get('repos').get(`github.com/${event.data.repo}`).get('seeders').set(me).val(foo => console.log('foo = ', foo));
      });
      self.clients.matchAll({ includeUncontrolled: true }).then(all => all.map(client => client.postMessage(msg)));
    }).catch(err => {
      let msg = {
        type: 'status',
        status: 'error',
        regarding: event.data,
        error: {
          message: err.message
        }
      };
      self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
    });
  } else if (event.data.type === 'list') {
    console.log('listing');
    fs.readdir('/', (err, files) => {
      UpdatedDirectoryList(event);
    });
  } else if (event.data.type == 'delete') {
    console.log('deleting');
    rimraf(event.data.directory).then(() => {
      UpdatedDirectoryList(event);
    });
  }
});

self.addEventListener('fetch', event => {
  let request = event.request;
  // We need to cache GET (readFile) and HEAD (getFileSize) requests for proper offline support.
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  // Is it for a package CDN?
  const requestHost = OmniPath.parse(request.url).hostname;
  if (requestHost === 'unpkg.com') return event.respondWith(permaCache(request, 'unpkg'));
  if (requestHost === 'wzrd.in') return event.respondWith(permaCache(request, 'wzrd'));
  if (requestHost === 'cdnjs.cloudflare.com') return event.respondWith(permaCache(request, 'cdnjs'));
  if (requestHost === 'api.cdnjs.com') return event.respondWith(permaCache(request, 'cdnjs'));
  if (requestHost === 'rawgit.com') return event.respondWith(permaCache(request, 'rawgit'));
  // For now, ignore other domains. We might very well want to cache them later though.
  if (!request.url.startsWith(self.location.origin)) return;
  // Turn URL into a file path
  let path = OmniPath.parse(request.url).pathname; //.replace(/^(https?:)?\/\/[^\/]+/, '')
  if (OmniPath.parse(request.url).query.uri && OmniPath.parse(request.url).query.uri === 'web+gitapp://0fda723910a6952176e73eeb5bbeaece1ef99110') {
    console.log('OH HEY COOL I KNOW THIS ONE HASH: ' + request.url);
    return event.respondWith(fetch('https://wmhilton.github.io/favicon/favicon-96x96.png'));
  }
  // Sanity check
  if (path === '') path = '/';
  // Otherwise, try fetching from the "file system".
  event.respondWith(serve(path));
});

async function permaCache(request, name) {
  let betterRequest = new Request(request.url, {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow'
  });
  let cache = await caches.open(name);
  let response = await cache.match(betterRequest.url);
  if (response) {
    return response;
  }
  response = fetch(betterRequest);
  response.then(res => {
    // Let's just cache the redirected result,
    // because that gives us true offline support,
    // and (unintentionally) pins module versions on first use.
    // TODO: Add a way to un-pin the cached version of an unpkg library.
    if (res.status === 200) cache.put(request.url, res.clone());
  });
  return response;
}
