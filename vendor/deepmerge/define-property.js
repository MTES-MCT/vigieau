// Do not invoke Object.prototype.__proto__ when copying an enumerable own key.
function setOwnProperty(target, key, value) {
	Object.defineProperty(target, key, {
		value: value,
		enumerable: true,
		configurable: true,
		writable: true
	})
}
