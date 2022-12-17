INSTALL_DIR=~/.local/share/gnome-shell/extensions/simple-window-organizer@lab309.com.br

.PHONY: default clean
default: simple-window-organizer.tar.xz

clean:
	rm -f schemas/gschemas.compiled
	rm -f simple-window-organizer.tar.xz

schemas/gschemas.compiled: schemas/*.xml
	glib-compile-schemas schemas/

simple-window-organizer.tar.xz: schemas/gschemas.compiled schemas/*.xml extension.js prefs.js metadata.json
	tar --create --xz --file $@ $^

install: simple-window-organizer.tar.xz
	mkdir -p $(INSTALL_DIR)
	tar --extract --recursive-unlink --xz --file $< --directory $(INSTALL_DIR)

