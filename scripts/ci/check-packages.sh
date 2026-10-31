#!/usr/bin/env bash
# Validate the package lists and apt sources under packages/linux: line
# formats, sort order and duplicates, unknown files, names listed and ignored,
# and the apt sources and keyrings. Reads the files as text, never runs them.
# Prints "<file>:<line>: <reason>" per problem and exits 1, or "<dir>: OK" and
# exits 0; a missing directory exits 2.
# Usage: scripts/ci/check-packages.sh [packages-dir]
set -euo pipefail

DIR=${1:-packages/linux}

if [[ ! -d $DIR ]]; then
    printf 'ERROR: no such directory: %s\n' "$DIR" >&2
    exit 2
fi

problems=0

bad() {
    printf '%s:%s: %s\n' "$1" "$2" "$3"
    problems=$(( problems + 1 ))
}

# -- The ten lists --------------------------------------------------------------

KNOWN_LISTS=(
    apt.txt deb.txt snap.txt npm.txt pipx.txt vscode-extensions.txt fonts.txt
    gnome-extensions.txt tools.txt drift-ignore.txt
)

# Names start with a letter or digit, so a line can't reach a root command as an
# option (--dangerous) or a path (..).
declare -A LIST_PATTERNS=(
    [apt.txt]='^[a-z0-9][a-z0-9+.-]*$'
    [deb.txt]='^[a-z0-9][a-z0-9+.-]* https://[A-Za-z0-9./_~+-]+\.deb [0-9a-f]{64}$'
    [snap.txt]='^[a-z0-9][a-z0-9-]*( classic)?( channel=[a-z0-9./-]+)?$'
    [npm.txt]='^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'
    [pipx.txt]='^[A-Za-z0-9][A-Za-z0-9._-]*$'
    [vscode-extensions.txt]='^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$'
    [fonts.txt]='^[A-Za-z0-9]+ v[0-9]+\.[0-9]+\.[0-9]+ [0-9a-f]{64}$'
    [gnome-extensions.txt]='^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9._-]+ https://github\.com/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]* [0-9a-f]{40}$'
    [tools.txt]='^(bun|copilot|nvm|rtk) https://(github\.com|raw\.githubusercontent\.com)/[A-Za-z0-9./_~+-]+ [0-9a-f]{64}$'
    [drift-ignore.txt]='^(apt|snap|npm|pipx|vscode|font|extension|apt-source) [A-Za-z0-9@][A-Za-z0-9@/+._-]*$'
)

is_known_list() {
    local name
    for name in "${KNOWN_LISTS[@]}"; do
        if [[ $1 == "$name" ]]; then
            return 0
        fi
    done
    return 1
}

# Check one list: data-line format, then LC_ALL=C sort order and duplicates on
# the whole line. Comment and blank lines are skipped.
check_list() {
    local name=$1 pattern=$2 line lineno=0 prev='' first
    while IFS= read -r line || [[ -n $line ]]; do
        lineno=$(( lineno + 1 ))
        if [[ $line =~ ^[[:space:]]*(#|$) ]]; then
            continue
        fi
        if [[ ! $line =~ $pattern ]]; then
            bad "$name" "$lineno" 'invalid entry'
            continue
        fi
        if [[ -n $prev ]]; then
            if [[ $line == "$prev" ]]; then
                bad "$name" "$lineno" 'duplicate'
            else
                first=$(printf '%s\n%s\n' "$prev" "$line" | LC_ALL=C sort | head -n 1)
                if [[ $first == "$line" ]]; then
                    bad "$name" "$lineno" 'not sorted'
                fi
            fi
        fi
        prev=$line
    done < "$DIR/$name"
}

for name in "${KNOWN_LISTS[@]}"; do
    if [[ -f $DIR/$name ]]; then
        check_list "$name" "${LIST_PATTERNS[$name]}"
    fi
done

# A file directly in the folder must be one of the ten; apt-sources is the one
# allowed directory.
while IFS= read -r name; do
    is_known_list "$name" || bad "$name" 1 'unknown list'
done < <(find "$DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)

# The only allowed top-level directory is apt-sources.
while IFS= read -r name; do
    [[ $name == apt-sources ]] || bad "$name" 1 'unknown list'
done < <(find "$DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)

# A symlink anywhere in the folder is never a package list or key.
while IFS= read -r path; do
    bad "${path#"$DIR"/}" 1 'symlink'
done < <(find "$DIR" -type l -printf '%p\n' | LC_ALL=C sort)

# -- Cross-list rules -----------------------------------------------------------

# A name in both apt.txt and deb.txt.
if [[ -f $DIR/apt.txt && -f $DIR/deb.txt ]]; then
    declare -A apt_names=()
    while IFS= read -r name; do
        apt_names["$name"]=1
    done < <(awk '!/^[[:space:]]*(#|$)/ { print $1 }' "$DIR/apt.txt")
    while read -r lineno name; do
        if [[ -n ${apt_names["$name"]:-} ]]; then
            bad 'deb.txt' "$lineno" "$name is also in apt.txt"
        fi
    done < <(awk '!/^[[:space:]]*(#|$)/ { print NR, $1 }' "$DIR/deb.txt")
fi

# A name in a list and under that list's manager in drift-ignore.txt.
declare -A ignored=()
if [[ -f $DIR/drift-ignore.txt ]]; then
    while read -r manager name; do
        ignored["$manager $name"]=1
    done < <(awk '!/^[[:space:]]*(#|$)/ && NF >= 2 { print $1, $2 }' "$DIR/drift-ignore.txt")
fi

declare -A manager_lists=(
    [apt]='apt.txt deb.txt'
    [snap]='snap.txt'
    [npm]='npm.txt'
    [pipx]='pipx.txt'
    [vscode]='vscode-extensions.txt'
    [font]='fonts.txt'
    [extension]='gnome-extensions.txt'
)

for manager in apt snap npm pipx vscode font extension; do
    for list in ${manager_lists[$manager]}; do
        [[ -f $DIR/$list ]] || continue
        while read -r lineno name; do
            if [[ -n ${ignored["$manager $name"]:-} ]]; then
                bad "$list" "$lineno" "$name is ignored for $manager in drift-ignore.txt"
            fi
        done < <(awk '!/^[[:space:]]*(#|$)/ { print NR, $1 }' "$DIR/$list")
    done
done

# -- apt sources and keys -------------------------------------------------------

sources=()
keys=()
if [[ -d $DIR/apt-sources ]]; then
    while IFS= read -r path; do
        rel=${path#"$DIR"/}
        case $rel in
            apt-sources/keyrings/*)
                if [[ $rel == *.gpg && ${rel#apt-sources/keyrings/} != */* ]]; then
                    keys+=("$rel")
                else
                    bad "$rel" 1 'unknown list'
                fi
                ;;
            apt-sources/*)
                sub=${rel#apt-sources/}
                if [[ $sub != */* && ( $sub == *.sources || $sub == *.list ) ]]; then
                    sources+=("$rel")
                else
                    bad "$rel" 1 'unknown list'
                fi
                ;;
        esac
    done < <(find "$DIR/apt-sources" -mindepth 1 -type f -printf '%p\n' | LC_ALL=C sort)

    # A source and an ignored apt-source share a basename: invalid as well.
    while IFS= read -r name; do
        if [[ -n ${ignored["apt-source $name"]:-} ]]; then
            bad "apt-sources/$name" 1 "$name is ignored for apt-source in drift-ignore.txt"
        fi
    done < <(find "$DIR/apt-sources" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
fi

declare -A referenced=()

# Every whitespace-separated URI in the value must be https.
check_uris() {
    local rel=$1 lineno=$2 value=$3 url
    local -a urls=()
    if [[ -n ${value//[[:space:]]/} ]]; then
        read -ra urls <<< "$value"
    fi
    for url in "${urls[@]}"; do
        if [[ $url != https://* ]]; then
            bad "$rel" "$lineno" 'URL is not https'
        fi
    done
}

# Validate one Signed-By / signed-by value: an exact path under one of the two
# keyring folders, whose basename must exist in keyrings/. Records the basename
# in referenced.
check_signed_by() {
    local rel=$1 lineno=$2 value=$3 base
    if [[ ! $value =~ ^(/usr/share/keyrings|/etc/apt/keyrings)/[A-Za-z0-9._-]+$ ]]; then
        bad "$rel" "$lineno" 'Signed-By is not a keyrings path'
        return
    fi
    base=${value##*/}
    referenced["$base"]=1
    if [[ ! -f $DIR/apt-sources/keyrings/$base ]]; then
        bad "$rel" "$lineno" "Signed-By names $base, which is not in apt-sources/keyrings"
    fi
}

# Check one source file. A .sources file is checked per stanza: a blank line ends
# a stanza, a comment line is skipped, and a line starting with whitespace
# continues the field above it. Every stanza with any field needs a Signed-By on
# one line, every URI must be https, and options that turn signature checks off
# fail. A .list file checks every deb/deb-src line on its own: it needs its own
# signed-by and an https URL, and the same options fail. Option names ignore case.
check_source() {
    local rel=$1 line lineno=0 value name rest field='' opts url opt
    local has_field=0 has_signed=0 saw_field=0 found_signed=0
    local -a opt_tokens=()
    while IFS= read -r line || [[ -n $line ]]; do
        lineno=$(( lineno + 1 ))

        if [[ $rel == *.sources ]]; then
            if [[ $line =~ ^[[:space:]]*# ]]; then
                continue
            fi
            if [[ $line =~ ^[[:space:]]*$ ]]; then
                if (( has_field == 1 && has_signed == 0 )); then
                    bad "$rel" 1 'no Signed-By'
                fi
                has_field=0
                has_signed=0
                field=''
                continue
            fi
            if [[ $line == [[:space:]]* ]]; then
                if [[ $field == uris ]]; then
                    check_uris "$rel" "$lineno" "${line#"${line%%[![:space:]]*}"}"
                elif [[ $field == signed-by ]]; then
                    bad "$rel" "$lineno" 'Signed-By continues on another line'
                fi
                continue
            fi
            name=${line%%:*}
            name=${name%%[[:space:]]*}
            name=${name,,}
            value=${line#*:}
            value=${value#"${value%%[![:space:]]*}"}
            value=${value%"${value##*[![:space:]]}"}
            saw_field=1
            has_field=1
            case $name in
                uris)
                    field=uris
                    check_uris "$rel" "$lineno" "$value"
                    ;;
                signed-by)
                    field=signed-by
                    has_signed=1
                    check_signed_by "$rel" "$lineno" "$value"
                    ;;
                trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)
                    field=$name
                    bad "$rel" "$lineno" "$name is not allowed"
                    ;;
                *)
                    field=$name
                    ;;
            esac
        else
            if [[ $line =~ ^[[:space:]]*(#|$) ]]; then
                continue
            fi
            if [[ $line =~ ^deb-src([[:space:]].*)?$ ]]; then
                rest=${line#deb-src}
            elif [[ $line =~ ^deb([[:space:]].*)?$ ]]; then
                rest=${line#deb}
            else
                bad "$rel" "$lineno" 'not a deb or deb-src line'
                continue
            fi
            opts=''
            url=''
            if [[ $rest =~ ^[[:space:]]+(\[[^]]*\])?[[:space:]]*([^[:space:]]+)([[:space:]].*)?$ ]]; then
                opts=${BASH_REMATCH[1]}
                url=${BASH_REMATCH[2]}
            fi
            if [[ -z $url ]]; then
                bad "$rel" "$lineno" 'missing URL'
                continue
            fi
            if [[ $url != https://* ]]; then
                bad "$rel" "$lineno" 'URL is not https'
            fi
            opts=${opts#[}
            opts=${opts%]}
            found_signed=0
            opt_tokens=()
            if [[ -n ${opts//[[:space:]]/} ]]; then
                read -ra opt_tokens <<< "$opts"
                for opt in "${opt_tokens[@]}"; do
                    case ${opt,,} in
                        trusted*|allow-insecure*|allow-weak*|allow-downgrade-to-insecure*)
                            bad "$rel" "$lineno" "${opt%%=*} is not allowed"
                            ;;
                        signed-by*)
                            found_signed=1
                            check_signed_by "$rel" "$lineno" "${opt#*=}"
                            ;;
                    esac
                done
            fi
            if (( found_signed == 0 )); then
                bad "$rel" "$lineno" 'no signed-by'
            fi
        fi
    done < "$DIR/$rel"

    if [[ $rel == *.sources ]] && (( saw_field == 0 || ( has_field == 1 && has_signed == 0 ) )); then
        bad "$rel" 1 'no Signed-By'
    fi
}

for rel in "${sources[@]}"; do
    check_source "$rel"
done

for rel in "${keys[@]}"; do
    base=${rel##*/}
    if [[ -z ${referenced["$base"]:-} ]]; then
        bad "$rel" 1 'not named by any source'
    fi
done

# -- Result ---------------------------------------------------------------------

if (( problems > 0 )); then
    printf '%s: invalid entries above\n' "$DIR"
    exit 1
fi
printf '%s: OK\n' "$DIR"
